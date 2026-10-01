/**
 * CLI implementation of the {@link LocalRuntimeProvisioner} seam.
 *
 * Owns the Node-specific mechanics of standing up *my code* for a `rayfin dev`
 * session: detecting the frontend dev script, gating on the functions
 * toolchain, claiming a function-host port, writing `local.settings.json` from
 * the backend wiring, building so debug source maps are fresh, starting the
 * type-generation watcher, and persisting the VS Code attach configuration once
 * the host answers.
 *
 * It composes {@link LocalFunctionsRuntimeService} (the output-free primitives
 * extracted in PR 3.1.1) and stays rendering-free itself: user-visible progress
 * goes through the injected `notify` sink that Layer 1 wires to the session's
 * output mode.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createLinkedCancellation,
  type CancellationToken,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type {
  LocalRuntimeProvisioner,
  LocalRuntimeReservation,
  LocalRuntimeSpec,
  PrepareLocalRuntimesInput,
  PrepareLocalRuntimesResult,
  ReserveLocalRuntimesResult,
} from '@microsoft/rayfin-tools-common/_internal/workflows/dev';

import { resolveServiceRoot } from '../../utils/config-utils.js';
import { patchClientForFunctions } from '../../utils/patch-client-for-functions.js';
import { ensureSecretsTypes } from '../../utils/secrets-types-generator.js';

import {
  DEFAULT_FUNCTIONS_INSPECT_PORT,
  DEFAULT_FUNCTIONS_PORT,
  FUNCTIONS_BUILD_WATCH_WARNING,
  type LocalFunctionsRuntimeService,
  createLocalFunctionsRuntimeService,
  runFunctionsBuild,
} from './functions-runtime.js';

/** Typed outcome of the host prerequisite gate for the functions runtime. */
export type FunctionsPrereqOutcome =
  | { status: 'ok' }
  | { status: 'unavailable'; code: string; message: string };

/** Collaborators for {@link createCliLocalRuntimeProvisioner}. */
export interface CliLocalRuntimeProvisionerDeps {
  /** The loaded `rayfin.yml`. */
  config: RayfinConfig;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /**
   * Prerequisite gate for the functions runtime (Node version, Core Tools).
   * Injected because consent prompting is a Layer 1 concern; omitted for a
   * session that has already verified the toolchain.
   */
  ensureFunctionsPrereqs?: () => Promise<FunctionsPrereqOutcome>;
  /** User-visible progress sink, wired by Layer 1 to the session output mode. */
  notify?: (message: string) => void;
  /** Enable the Node inspector on the functions host. Defaults to `true`. */
  debug?: boolean;
  /** Inspector port advertised to `.vscode/launch.json`. */
  inspectPort?: string;
  /** Session-scoped ports already claimed by sibling local runtimes. */
  reservedPorts?: Set<number>;
  /** Host primitives seam; injected by tests. */
  functionsRuntime?: LocalFunctionsRuntimeService;
  /** Pre-start build seam; injected by tests to avoid spawning a real build. */
  runBuild?: (input: {
    command: string;
    cwd: string;
    signal?: CancellationToken;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  }) => Promise<void>;
  /** Build stdout sink selected by Layer 1 for the active output mode. */
  onBuildStdout?: (chunk: string) => void;
  /** Build stderr sink selected by Layer 1 for the active output mode. */
  onBuildStderr?: (chunk: string) => void;
  /** Client-patch seam; injected by tests. */
  patchClient?: typeof patchClientForFunctions;
  /** npm-script probe seam; injected by tests. */
  hasNpmScript?: (dir: string, name: string) => boolean;
  /** npm-script content seam; injected by tests. */
  readNpmScript?: (dir: string, name: string) => string | undefined;
}

const FRONTEND_RUNTIME_ID = 'frontend';
const FUNCTIONS_RUNTIME_ID = 'functions';
const FRONTEND_SCRIPT = 'dev:frontend';
const LEGACY_FRONTEND_SCRIPT = 'dev';
const RECURSIVE_FRONTEND_SCRIPT = /\brayfin(?:\.cmd)?\s+dev\b/i;

/**
 * Build the CLI's local-runtime provisioner. Session-scoped: the port claimed
 * in `reserve` is the port `prepare` writes into settings and passes to
 * `func start`.
 */
export function createCliLocalRuntimeProvisioner(
  deps: CliLocalRuntimeProvisionerDeps
): LocalRuntimeProvisioner {
  const {
    config,
    projectRoot,
    ensureFunctionsPrereqs,
    notify = (): void => {},
    debug = true,
    inspectPort = DEFAULT_FUNCTIONS_INSPECT_PORT,
    reservedPorts,
    functionsRuntime = createLocalFunctionsRuntimeService({ reservedPorts }),
    runBuild = runFunctionsBuild,
    onBuildStdout,
    onBuildStderr,
    patchClient = patchClientForFunctions,
    hasNpmScript: probeNpmScript = hasNpmScript,
    readNpmScript: readScript = readNpmScript,
  } = deps;

  const frontendDir = config.services.staticHosting?.path
    ? join(projectRoot, config.services.staticHosting.path)
    : projectRoot;

  let functionsDir: string | undefined;
  let functionsPort: string | undefined;
  let functionsInspectPort: string | undefined;
  let frontendScript: string | undefined;

  return {
    async reserve({ signal }): Promise<ReserveLocalRuntimesResult> {
      const reservations: LocalRuntimeReservation[] = [];

      frontendScript = probeNpmScript(frontendDir, FRONTEND_SCRIPT)
        ? FRONTEND_SCRIPT
        : probeNpmScript(frontendDir, LEGACY_FRONTEND_SCRIPT)
          ? LEGACY_FRONTEND_SCRIPT
          : undefined;
      if (
        frontendScript &&
        RECURSIVE_FRONTEND_SCRIPT.test(
          readScript(frontendDir, frontendScript) ?? ''
        )
      ) {
        return {
          status: 'unavailable',
          code: 'frontend-script-recursive',
          message:
            `The "${frontendScript}" npm script invokes \`rayfin dev\`, ` +
            'which would recursively start another development session.',
        };
      }
      if (frontendScript) {
        reservations.push({
          id: FRONTEND_RUNTIME_ID,
          label: 'frontend dev server',
        });
      }

      if (config.services.functions?.enabled !== true) {
        return { status: 'reserved', reservations };
      }

      const prereqs = (await ensureFunctionsPrereqs?.()) ?? { status: 'ok' };
      if (prereqs.status === 'unavailable') return prereqs;
      if (signal?.isCancellationRequested === true) {
        return { status: 'reserved', reservations };
      }

      try {
        functionsDir = resolveServiceRoot(
          projectRoot,
          'functions',
          config.services.functions.path ?? 'rayfin/functions'
        );
      } catch (error) {
        return {
          status: 'unavailable',
          code: 'functions-path-invalid',
          message: `Could not resolve the functions package: ${messageOf(error)}`,
        };
      }

      // 7071 is the Core Tools default and collides readily with a stale
      // `func start` from another project, so slide forward within a bounded
      // window rather than failing the whole session on a busy port.
      const requested = Number.parseInt(DEFAULT_FUNCTIONS_PORT, 10);
      const { port, searched } =
        await functionsRuntime.findAvailablePort(requested);
      if (port === null) {
        return {
          status: 'unavailable',
          code: 'functions-port-unavailable',
          message: `No free port available between ${searched.from} and ${searched.to} for the functions runtime.`,
        };
      }
      if (port !== requested) {
        notify(
          `ℹ️  Functions port ${requested} is in use — using nearest free port ${port} instead.`
        );
      }
      functionsPort = String(port);

      if (debug) {
        const parsedInspectPort = Number.parseInt(inspectPort, 10);
        const requestedInspectPort =
          Number.isInteger(parsedInspectPort) && parsedInspectPort > 0
            ? parsedInspectPort
            : Number.parseInt(DEFAULT_FUNCTIONS_INSPECT_PORT, 10);
        const inspectSearch =
          await functionsRuntime.findAvailablePort(requestedInspectPort);
        if (inspectSearch.port === null) {
          return {
            status: 'unavailable',
            code: 'functions-inspector-port-unavailable',
            message: `No free port available between ${inspectSearch.searched.from} and ${inspectSearch.searched.to} for the Node inspector.`,
          };
        }
        if (inspectSearch.port !== requestedInspectPort) {
          notify(
            `ℹ️  Inspector port ${requestedInspectPort} is in use — using nearest free port ${inspectSearch.port} instead.`
          );
        }
        functionsInspectPort = String(inspectSearch.port);
      }

      reservations.push({
        id: FUNCTIONS_RUNTIME_ID,
        label: 'functions runtime',
        url: `http://localhost:${functionsPort}`,
      });
      return { status: 'reserved', reservations };
    },

    async prepare({
      env,
      reservations,
      signal,
    }: PrepareLocalRuntimesInput): Promise<PrepareLocalRuntimesResult> {
      const runtimes: LocalRuntimeSpec[] = [];
      const warnings: string[] = [];
      const isCancelled = (): boolean =>
        signal?.isCancellationRequested === true;

      if (reservations.some((r) => r.id === FRONTEND_RUNTIME_ID)) {
        runtimes.push({
          id: FRONTEND_RUNTIME_ID,
          label: 'frontend dev server',
          command: 'npm',
          args: ['run', frontendScript ?? LEGACY_FRONTEND_SCRIPT],
          cwd: frontendDir,
        });
      }

      const functionsReserved = reservations.some(
        (reservation) => reservation.id === FUNCTIONS_RUNTIME_ID
      );
      if (!functionsReserved) {
        return { status: 'prepared', runtimes, warnings };
      }
      if (!functionsDir || !functionsPort || (debug && !functionsInspectPort)) {
        return {
          status: 'unavailable',
          code: 'functions-state-missing',
          message:
            'The functions runtime reservation is missing its prepared host state.',
        };
      }

      // The functions host reads its Rayfin coordinates from
      // `local.settings.json`, not from the process env, so the backend wiring
      // has to be written to disk before `func start`.
      await functionsRuntime.upsertLocalSettings(functionsDir, {
        AZURE_FUNCTIONS_ENVIRONMENT: 'Development',
        ...pickSettings(env),
        ...(debug
          ? {
              languageWorkers__node__arguments: `--inspect=${functionsInspectPort ?? inspectPort}`,
            }
          : {}),
      });

      const buildCommand =
        config.services.functions?.buildCommand ?? 'npm run build';
      try {
        // Handlers may already reference `ctx.Secrets.<NAME>`; without the
        // generated registry the build fails with TS2339 and typegen below is
        // never reached.
        ensureSecretsTypes(functionsDir, (message) => notify(`⚠️  ${message}`));
        notify(`🔨 Building functions project (${buildCommand})...`);
        await runBuild({
          command: buildCommand,
          cwd: functionsDir,
          signal,
          onStdout: onBuildStdout,
          onStderr: onBuildStderr,
        });
      } catch (error) {
        if (isCancelled()) {
          return { status: 'cancelled' };
        }
        return {
          status: 'unavailable',
          code: 'functions-build-failed',
          message: `Could not build the functions package: ${messageOf(error)}`,
        };
      }
      if (isCancelled()) {
        return { status: 'cancelled' };
      }

      try {
        const patch = await patchClient(projectRoot);
        if (patch.manual) {
          warnings.push(
            'Could not auto-configure functions routing. This is expected if your Vite config uses the rayfinLocalDev() proxy. Otherwise, set `functionsBaseUrl` from `VITE_RAYFIN_FUNCTIONS_URL` only while `import.meta.env.DEV` is true.'
          );
        }
      } catch (error) {
        warnings.push(
          `Could not update client code for local functions: ${messageOf(error)}`
        );
      }
      if (isCancelled()) {
        return { status: 'cancelled' };
      }

      let buildWatcher: LocalRuntimeSpec | undefined;
      try {
        buildWatcher = await functionsRuntime.createBuildWatcher(functionsDir);
      } catch (error) {
        return {
          status: 'unavailable',
          code: 'functions-watch-unavailable',
          message: `Could not watch the functions package: ${messageOf(error)}`,
        };
      }
      if (isCancelled()) return { status: 'cancelled' };
      if (!buildWatcher) {
        warnings.push(FUNCTIONS_BUILD_WATCH_WARNING);
        notify(`Warning: ${FUNCTIONS_BUILD_WATCH_WARNING}`);
      }
      const corsOrigins = functionsRuntime.resolveCorsOrigins(config);
      const typegen = await functionsRuntime.startTypegen({
        functionsDir,
        onRegenerate: (filename) =>
          notify(`[typegen] ✅ Regenerated types.ts (changed: ${filename}).`),
        onError: (error) => notify(`[typegen] ⚠️  ${error.message}`),
      });
      if (typegen.initialError) {
        warnings.push(
          `Initial function type generation failed: ${typegen.initialError.message}. The watcher retries on the next source change.`
        );
      }
      if (isCancelled()) {
        typegen.close();
        return { status: 'cancelled' };
      }

      // Started here rather than after the spawn so the readiness probe is
      // already polling when `func start` binds; it writes nothing unless the
      // host answers, so a failed launch never litters the workspace.
      const debuggerCancellation = createLinkedCancellation(signal);
      const debuggerInput = {
        projectRoot,
        functionsDir,
        port: functionsPort,
        inspectPort: functionsInspectPort ?? inspectPort,
        syncPort: debug,
        signal: debuggerCancellation.token,
      };
      const debuggerConfig = Promise.resolve()
        .then(() => functionsRuntime.ensureDebuggerConfig(debuggerInput))
        .then((result) => {
          if (result.status === 'written') {
            notify(`📝 Added "Functions: Attach" to ${result.path}.`);
          } else if (result.status === 'updated') {
            notify(
              `📝 Updated "Functions: Attach" in ${result.path} to port ${result.port}.`
            );
          } else if (result.status === 'invalid-json') {
            notify(
              `⚠️  ${result.path} is not strict JSON — add a "Functions: Attach" configuration manually.`
            );
          }
        })
        .catch(() => {
          // Debugger config is a convenience; never fail the session for it.
        })
        .finally(() => debuggerCancellation.dispose());

      if (buildWatcher) runtimes.push(buildWatcher);
      let disposed = false;
      runtimes.push({
        id: FUNCTIONS_RUNTIME_ID,
        label: `functions runtime on port ${functionsPort}`,
        command: 'func',
        // `--inspect` is deliberately not passed on the command line: Core
        // Tools wires it onto the .NET host, not the Node worker, which reads
        // it from `languageWorkers__node__arguments` in `local.settings.json`.
        args: [
          'start',
          '--port',
          functionsPort,
          ...(corsOrigins.length > 0 ? ['--cors', corsOrigins.join(',')] : []),
        ],
        cwd: functionsDir,
        inheritStdio: true,
        required: true,
        async dispose(): Promise<void> {
          if (disposed) return;
          disposed = true;
          try {
            typegen.close();
          } finally {
            debuggerCancellation.cancel();
            await debuggerConfig;
          }
        },
      });

      return { status: 'prepared', runtimes, warnings };
    },
  };
}

/**
 * Project the backend wiring env onto the `local.settings.json` keys the
 * functions host reads. Values the provider did not supply are omitted rather
 * than written empty, so a partial wiring never clobbers a working setting.
 */
function pickSettings(env: Record<string, string>): Record<string, string> {
  const mapping: Record<string, string> = {
    RAYFIN_PUBLIC_API_URL: 'RAYFIN_API_URL',
    RAYFIN_PUBLIC_PUBLISHABLE_KEY: 'RAYFIN_PUBLISHABLE_KEY',
    RAYFIN_FABRIC_WORKSPACE_ID: 'RAYFIN_FABRIC_WORKSPACE_ID',
    RAYFIN_FABRIC_ITEM_ID: 'RAYFIN_FABRIC_ITEM_ID',
  };
  const settings: Record<string, string> = {};
  for (const [source, target] of Object.entries(mapping)) {
    const value = env[source];
    if (value) settings[target] = value;
  }
  return settings;
}

/** Whether `<dir>/package.json` declares an npm script named `name`. */
function hasNpmScript(dir: string, name: string): boolean {
  return readNpmScript(dir, name) !== undefined;
}

/** Read an npm script command from `<dir>/package.json`. */
function readNpmScript(dir: string, name: string): string | undefined {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.[name];
    return typeof script === 'string' ? script : undefined;
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
