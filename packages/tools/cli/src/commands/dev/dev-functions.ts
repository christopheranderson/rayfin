import { join } from 'path';

import {
  createLinkedCancellation,
  type Diagnostics,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import { extractSafeParamNames } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { Command } from 'commander';

import {
  createBuildOutput,
  createChildOutputSinks,
} from '../../adapters/child-output.js';
import { createDiagnosticRunner } from '../../adapters/diagnostic-runner.js';
import { createFunctionsOutputRunner } from '../../adapters/functions-output.js';
import { cliCommandRunner } from '../../adapters/runner.js';
import { ensureAuthenticated } from '../../auth/index.js';
import { getFabricSettings } from '../../config/constants.js';
import {
  createCliDiagnosticSession,
  type DiagnosticOutcome,
} from '../../diagnostics/session.js';
import {
  classifyCliError,
  CliCancelledError,
  CliHandledError,
} from '../../errors.js';
import {
  DEFAULT_FUNCTIONS_INSPECT_PORT,
  DEFAULT_FUNCTIONS_PORT,
  FUNCTIONS_BUILD_WATCH_WARNING,
  createLocalFunctionsRuntimeService,
  runFunctionsBuild,
  type FunctionsTypegenSession,
} from '../../local-services/dev/functions-runtime.js';
import {
  loadRayfinConfig,
  resolveServiceRoot,
} from '../../utils/config-utils.js';
import {
  getActiveDeployment,
  isDeployedRecord,
} from '../../utils/deployments-registry.js';
import { upsertEnvVariables } from '../../utils/env-file-utils.js';
import { detectFrontendFramework } from '../../utils/frontend-detect.js';
import {
  inspectFunctionsPrereqs,
  planFunctionsInstall,
  formatPrereqsReport,
  formatStepCommand,
  promptAndInstall,
  refreshPathFromOs,
} from '../../utils/functions-prereqs.js';
import {
  emitJson,
  emitJsonError,
  isInteractive,
  modeError,
  modeLog,
  modeWarn,
  resolveCommandFlags,
} from '../../utils/output-mode.js';
import { patchClientForFunctions } from '../../utils/patch-client-for-functions.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import { getPublishableKey } from '../../utils/publishable-key-utils.js';
import { ensureSecretsTypes } from '../../utils/secrets-types-generator.js';
import { getPackageVersion } from '../../utils/version.js';
import { writeFrameworkEnvFile } from '../env/env.js';

interface DevFunctionsApplyOptions {
  port: string;
  inspectPort: string;
  debug: boolean;
  emitEnv: boolean;
}

/**
 * Construct the deployed Fabric Rayfin item endpoint from a deployment record.
 * Mirrors `getRemoteEndpoint()` but takes a {@link DeploymentRecord} directly
 * so we don't re-read the registry.
 */
function buildItemEndpoint(workspaceId: string, itemId: string): string {
  const apiBaseUrl = getFabricSettings().fabricApiBaseUrl.replace(/\/$/, '');
  return `${apiBaseUrl}/workspaces/${workspaceId}/appBackends/${itemId}`;
}

/**
 * Implementation of `rayfin dev functions apply`.
 *
 * Flow:
 *  1. Gate on `services.functions.enabled: true` in `rayfin.yml`.
 *  2. Detect prerequisites (Node ≥ 20, Azure Functions Core Tools);
 *     prompt for explicit consent on every missing install.
 *  3. Resolve the active deployment + publishable key (Fabric MSAL bearer).
 *  4. Merge `AZURE_FUNCTIONS_ENVIRONMENT=Development` + Rayfin endpoint info
 *     into `rayfin/functions/local.settings.json`.
 *  5. Upsert `RAYFIN_PUBLIC_FUNCTIONS_URL` into `rayfin/.env` (so
 *     `rayfin env` projects it to `VITE_RAYFIN_FUNCTIONS_URL`).
 *  6. Regenerate the framework `.env.local` (unless `--no-emit-env`).
 *  7. Foreground-spawn `func start --port <p> --inspect=<i>`.
 */
async function devFunctionsApplyAction(
  options: DevFunctionsApplyOptions,
  command: Command
): Promise<void> {
  const flags = resolveCommandFlags(command);
  const session = await createCliDiagnosticSession({
    commandName: 'dev functions apply',
    cliVersion: getPackageVersion(),
    projectRoot: process.cwd(),
    safeParameterNames: extractSafeParamNames(process.argv.slice(2)),
    mirror:
      flags.verbose && flags.mode !== 'json'
        ? (line) => {
            process.stderr.write(line);
          }
        : undefined,
  });
  let outcome: DiagnosticOutcome = { status: 'failed', exitCode: 1 };
  let buildOutput: string | undefined;
  try {
    const functionsUrl = await executeDevFunctionsApply(
      options,
      flags,
      session.diagnostics,
      (output) => {
        buildOutput = output;
      }
    );
    outcome = { status: 'success', exitCode: 0 };
    if (flags.mode === 'json') emitJson({ status: 'success', functionsUrl });
  } catch (error) {
    const cause =
      error instanceof CliHandledError ? error.originalError : error;
    outcome = { ...classifyCliError(error), error: cause };
    if (error instanceof CliCancelledError) {
      if (flags.mode === 'json') emitJson({ status: 'cancelled' });
      throw error;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    const hint =
      'Check the Functions prerequisites and build configuration, then retry.';
    if (flags.mode === 'json') {
      emitJsonError(
        flags.mode,
        message,
        {
          hint,
          diagnosticLog: session.logPath,
          ...(buildOutput ? { buildOutput } : {}),
        },
        cause
      );
    }
    if (buildOutput && !flags.verbose)
      createChildOutputSinks(flags.mode).stderr(buildOutput);
    modeError(
      flags.mode,
      `${flags.mode === 'interactive' ? '❌ ' : ''}Could not run local functions: ${message}`
    );
    modeError(flags.mode, `   ${hint}`);
    if (session.logPath)
      modeError(flags.mode, `   Diagnostic log: ${session.logPath}`);
    throw new CliHandledError(cause);
  } finally {
    await session.close(outcome);
  }
}

async function executeDevFunctionsApply(
  options: DevFunctionsApplyOptions,
  flags: ReturnType<typeof resolveCommandFlags>,
  diagnostics: Diagnostics,
  onBuildFailure: (output: string) => void
): Promise<string> {
  const { mode } = flags;
  const childOutput = createChildOutputSinks(mode);
  const interactive = mode !== 'json' && isInteractive({ yes: flags.yes });
  const functionsRuntime = createLocalFunctionsRuntimeService();
  let projectRoot: string;
  try {
    projectRoot = findRayfinProjectRoot(process.cwd(), { silent: true });
  } catch {
    throw new Error(
      'Not inside a Rayfin project (no `rayfin/` folder). Run this command from your project.'
    );
  }

  // ── Feature-flag / config gate ─────────────────────────────────────
  const rayfinConfig = loadRayfinConfig(projectRoot, { silent: true });
  if (!rayfinConfig?.services?.functions?.enabled) {
    throw new Error(
      "Functions service is not enabled. Set 'services.functions.enabled: true' in rayfin.yml and re-run."
    );
  }

  const functionsServiceRoot = resolveServiceRoot(
    projectRoot,
    'functions',
    rayfinConfig.services.functions?.path ?? 'rayfin/functions'
  );

  // ── Prerequisite detection + (consent-gated) install ──────────────
  modeLog(mode, 'Preparing local functions...');
  let report = inspectFunctionsPrereqs();

  // If a prereq looks missing, the user may have installed it in a sibling
  // shell since this process started. Re-read PATH from the persistent OS
  // environment and re-detect before prompting them through another install.
  if (!report.funcCoreTools.ok) {
    refreshPathFromOs();
    report = inspectFunctionsPrereqs();
  }
  diagnostics.debug({
    area: 'functions.prerequisites',
    message: formatPrereqsReport(report),
  });

  const plan = planFunctionsInstall(report);
  if (plan.length > 0) {
    if (!report.node.ok) {
      // We intentionally do not auto-install Node — that's too invasive.
      throw new Error(
        `Node.js >= ${report.node.minimumMajor} is required. ` +
          'Please upgrade your Node runtime and re-run.'
      );
    }
    if (!interactive) {
      throw new Error(
        `Missing Functions prerequisites. Run the following commands, then retry:\n${plan.map((step) => `   ${formatStepCommand(step)}`).join('\n')}`
      );
    }
    const installed = await promptAndInstall(plan, {
      isInteractive: interactive,
      logger: (message) => modeLog(mode, message),
    });
    if (!installed) {
      throw new Error(
        'Functions prerequisite installation was not completed. Install the required tools, then retry.'
      );
    }
    // Re-inspect to confirm install succeeded.
    report = inspectFunctionsPrereqs();
    diagnostics.debug({
      area: 'functions.prerequisites',
      message: formatPrereqsReport(report),
    });
    if (!report.funcCoreTools.ok) {
      throw new Error(
        'Azure Functions Core Tools still not detected on PATH. ' +
          'Open a new shell so PATH updates take effect, then re-run `rayfin dev functions apply`.'
      );
    }
  }

  // ── Resolve deployed item + publishable key ──────────────────────
  const active = getActiveDeployment(projectRoot);
  // A pre-seeded record from `rayfin init --workspace-id` is an active record
  // without a deployed item, so existence alone would let it through and fail
  // below on the empty `apiUrl` — reporting a missing field rather than the
  // actual cause, which is that no deploy has happened yet.
  if (!active || !isDeployedRecord(active.record)) {
    throw new Error(
      "No active deployment found. Run 'rayfin up' to deploy your Rayfin item first."
    );
  }
  const { record } = active;
  const itemEndpoint = buildItemEndpoint(record.workspaceId, record.itemId);
  // The Rayfin data plane URL (workload endpoint) is stored on the
  // deployment record as `apiUrl`. It's distinct from `itemEndpoint`,
  // which points at the Fabric REST control plane and is used for
  // publishable-key lookup and other admin calls.
  const dataPlaneUrl = record.apiUrl.replace(/\/$/, '');

  diagnostics.debug({
    area: 'functions',
    message: 'Resolving publishable key',
  });
  const tokenResult = await ensureAuthenticated();
  const publishableKey = await getPublishableKey(itemEndpoint, record.itemId, {
    authorizationHeader: `Bearer ${tokenResult.token}`,
  });

  // ── Resolve a free port at/above the requested --port ─────────────
  // 7071 is the Azure Functions Core Tools default, and we frequently
  // collide with a stale `func start` from a previous smoke run or a
  // separate Rayfin project that's still active. Probe the requested
  // port first; if it's in use, slide forward to the next free port in
  // the window and keep going. The resolved port flows into both the
  // browser-visible env (`RAYFIN_PUBLIC_FUNCTIONS_URL`) and the
  // `func start --port` argument, so callers never need to know about
  // the auto-shift.
  const requestedPort = Number.parseInt(options.port, 10);
  if (!Number.isInteger(requestedPort) || requestedPort <= 0) {
    throw new Error(
      `Invalid --port value '${options.port}'; use a positive integer.`
    );
  }
  const { port: resolvedPort, searched } =
    await functionsRuntime.findAvailablePort(requestedPort);
  if (resolvedPort === null) {
    throw new Error(
      `No free port available between ${searched.from} and ${searched.to}. ` +
        'Stop the conflicting process or pass --port <N> with an open port.'
    );
  }
  if (resolvedPort !== requestedPort) {
    modeLog(
      mode,
      `Port ${requestedPort} is in use; using nearest free port ${resolvedPort} instead.`
    );
  }
  // Mutate `options.port` once so every downstream consumer (spawn args,
  // env writes, launch.json attach) sees the same resolved value.
  options.port = String(resolvedPort);

  // ── Write local.settings.json ────────────────────────────────────
  // `languageWorkers__node__arguments` is the documented way to make Azure
  // Functions Core Tools pass `--inspect=<port>` to the Node worker child
  // process. The top-level `func start --inspect=<port>` flag is reliable
  // for the .NET host but NOT for the Node worker (different process
  // tree), so without this setting the inspector never binds to its port
  // and `Functions: Attach` immediately disconnects.
  const functionsDir = functionsServiceRoot;
  await functionsRuntime.upsertLocalSettings(functionsDir, {
    AZURE_FUNCTIONS_ENVIRONMENT: 'Development',
    RAYFIN_API_URL: dataPlaneUrl,
    RAYFIN_PUBLISHABLE_KEY: publishableKey,
    RAYFIN_FABRIC_WORKSPACE_ID: record.workspaceId,
    RAYFIN_FABRIC_ITEM_ID: record.itemId,
    ...(options.debug
      ? { languageWorkers__node__arguments: `--inspect=${options.inspectPort}` }
      : {}),
  });
  diagnostics.debug({
    area: 'functions',
    message: `Updated ${join(functionsDir, 'local.settings.json')}`,
  });

  // ── Upsert RAYFIN_PUBLIC_FUNCTIONS_URL into rayfin/.env ───────────
  const functionsUrl = `http://localhost:${options.port}`;
  const rayfinDir = join(projectRoot, 'rayfin');
  await upsertEnvVariables(rayfinDir, [
    { key: 'RAYFIN_PUBLIC_FUNCTIONS_URL', value: functionsUrl },
  ]);
  diagnostics.debug({
    area: 'functions',
    message: `Set local functions URL to ${functionsUrl}`,
  });

  // ── Regenerate framework .env.local (unless --no-emit-env) ────────
  if (options.emitEnv) {
    const framework = detectFrontendFramework(projectRoot);
    if (framework) {
      try {
        const filePath = await writeFrameworkEnvFile({
          projectRoot,
          framework,
          outputDir: '.',
        });
        diagnostics.debug({
          area: 'functions',
          message: `Regenerated ${filePath} (${framework})`,
        });
      } catch (error) {
        modeWarn(
          mode,
          `Could not emit framework .env.local: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  // ── Patch client code to wire functionsBaseUrl (first run only) ────
  const patchResult = await patchClientForFunctions(projectRoot);
  if (patchResult.patched) {
    diagnostics.debug({
      area: 'functions',
      message: 'Updated client code to route functions locally',
      data: { files: patchResult.files },
    });
  } else if (patchResult.manual) {
    modeWarn(
      mode,
      'Could not auto-configure functions routing. This is expected if your Vite config uses the rayfinLocalDev() proxy. Otherwise, add this to your RayfinClient configuration:'
    );
    modeWarn(
      mode,
      '   functionsBaseUrl: import.meta.env.DEV ? import.meta.env.VITE_RAYFIN_FUNCTIONS_URL : undefined'
    );
  }

  const session = createLinkedCancellation();
  const buildOutput = createBuildOutput(diagnostics, 'functions.build');
  const runner = createFunctionsOutputRunner(
    createDiagnosticRunner(cliCommandRunner, diagnostics),
    mode !== 'json' && !flags.verbose
  );
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    session.cancel();
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let typegen: FunctionsTypegenSession | undefined;
  let debuggerConfig: Promise<void> | undefined;
  const buildCommand =
    rayfinConfig.services.functions.buildCommand ?? 'npm run build';

  try {
    // Handlers may already reference `ctx.Secrets.<NAME>`; without the
    // generated registry the build fails with TS2339 and typegen below is
    // never reached.
    ensureSecretsTypes(functionsDir, (message) => modeWarn(mode, message));
    modeLog(mode, `Building functions project (${buildCommand})...`);
    try {
      await runFunctionsBuild({
        command: buildCommand,
        cwd: functionsDir,
        signal: session.token,
        onStdout: buildOutput.stdout,
        onStderr: buildOutput.stderr,
      });
    } catch (error) {
      if (!cancelled) onBuildFailure(buildOutput.tail());
      throw error;
    } finally {
      buildOutput.end();
    }
    if (cancelled) throw new CliCancelledError();
    const buildWatcher =
      await functionsRuntime.createBuildWatcher(functionsDir);
    if (cancelled) throw new CliCancelledError();
    if (!buildWatcher) modeWarn(mode, FUNCTIONS_BUILD_WATCH_WARNING);

    typegen = await functionsRuntime.startTypegen({
      functionsDir,
      onRegenerate: (filename) =>
        modeLog(mode, `[typegen] Regenerated types.ts (changed: ${filename}).`),
      onError: (error) => modeWarn(mode, `[typegen] ${error.message}`),
    });
    if (cancelled) throw new CliCancelledError();
    if (typegen.initialError) {
      modeWarn(
        mode,
        `[typegen] Initial generation failed: ${typegen.initialError.message}. The watcher will retry on the next source change.`
      );
    }
    diagnostics.debug({
      area: 'functions',
      message: `Watching ${join(functionsDir, 'src')} for type changes`,
    });

    const corsOrigins = functionsRuntime.resolveCorsOrigins(rayfinConfig);
    const funcArgs = [
      'start',
      '--port',
      options.port,
      ...(corsOrigins.length > 0 ? ['--cors', corsOrigins.join(',')] : []),
    ];
    modeLog(mode, `Starting functions at ${functionsUrl}...`);

    debuggerConfig = functionsRuntime
      .ensureDebuggerConfig({
        projectRoot,
        functionsDir,
        port: options.port,
        inspectPort: options.inspectPort,
        syncPort: options.debug,
        signal: session.token,
      })
      .then((result) => {
        if (result.status === 'written') {
          diagnostics.debug({
            area: 'functions',
            message: `Added "Functions: Attach" to ${result.path}`,
          });
        } else if (result.status === 'updated') {
          modeLog(
            mode,
            `Updated "Functions: Attach" in ${result.path} to port ${result.port}.`
          );
        } else if (result.status === 'invalid-json') {
          modeWarn(
            mode,
            `${result.path} is not strict JSON. Add a "Functions: Attach" configuration manually.`
          );
        }
      })
      .catch((error: unknown) =>
        modeWarn(mode, `Could not update .vscode/launch.json: ${String(error)}`)
      );

    let failure: Error | undefined;
    await Promise.all(
      [
        ...(buildWatcher ? [buildWatcher] : []),
        { command: 'func', args: funcArgs, cwd: functionsDir },
      ].map(async (runtime) => {
        if (session.token.isCancellationRequested) return;
        try {
          const result = await runner.run(runtime.command, runtime.args, {
            cwd: runtime.cwd,
            inheritStdio: false,
            inheritStdin: runtime !== buildWatcher && interactive,
            captureOutput: false,
            signal: session.token,
            onStdout:
              mode !== 'json' && !flags.verbose
                ? childOutput.stdout
                : undefined,
            onStderr:
              mode !== 'json' && !flags.verbose
                ? childOutput.stderr
                : undefined,
          });
          if (!result.cancelled && !cancelled) {
            if (!result.launched) {
              throw new Error(
                result.spawnError ?? `Could not start ${runtime.command}`
              );
            }
            if (runtime === buildWatcher || result.exitCode !== 0) {
              throw new Error(
                `${runtime === buildWatcher ? 'Functions compiler watcher' : 'Functions host'} exited with code ${result.exitCode}.`
              );
            }
          }
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
        } finally {
          session.cancel();
        }
      })
    );
    if (failure) throw failure;
  } catch (error) {
    if (!cancelled) throw error;
  } finally {
    buildOutput.end();
    session.cancel();
    try {
      typegen?.close();
    } finally {
      await debuggerConfig;
      session.dispose();
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }

  if (cancelled) throw new CliCancelledError();
  return functionsUrl;
}

/**
 * `rayfin dev functions apply` — verify host prerequisites (Azure Functions
 * Core Tools, Node ≥ 20), install missing ones with explicit per-step
 * consent, then start the local function runtime against the active
 * deployment.
 *
 * Sits alongside the existing `rayfin dev db apply` and
 * `rayfin dev storage apply` subcommands. Registered unconditionally in
 * `dev.ts`; the runtime still keys on `services.functions.enabled: true` in
 * `rayfin.yml`.
 */
export const devFunctionsCommand = new Command('functions')
  .description('Functions operations for local development')
  .addCommand(
    new Command('apply')
      .description(
        'Verify Azure Functions Core Tools prerequisites (with consent), then start the local Rayfin functions runtime against the active deployment'
      )
      .option(
        '--port <port>',
        'Port for the local function host',
        DEFAULT_FUNCTIONS_PORT
      )
      .option(
        '--inspect-port <port>',
        'Port for the Node.js inspector when --debug is on',
        DEFAULT_FUNCTIONS_INSPECT_PORT
      )
      .option('--no-debug', 'Disable the Node.js inspector on func start')
      .option(
        '--no-emit-env',
        'Skip auto-regenerating the framework .env.local from rayfin/.env'
      )
      .option('--verbose', 'Show detailed diagnostic output')
      .option('--json', 'Output result as JSON')
      .option('-y, --yes', 'Run without interactive prompts')
      .action(async (options: DevFunctionsApplyOptions, command: Command) => {
        await devFunctionsApplyAction(options, command);
      })
  );
