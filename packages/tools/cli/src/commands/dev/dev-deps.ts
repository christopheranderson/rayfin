/**
 * Assembles the {@link DevDeps} capability slice the `dev` workflow declares,
 * and selects the backend provider from `--provider`.
 *
 * This is the `dev`-specific view of the Layer 1 host container: it constructs
 * the chosen {@link DevBackendProvider} (Fabric by default, Docker when
 * requested and enabled) from the CLI's adapter impls and product-service
 * factories, wires the command runner for the local runtimes, and builds the
 * {@link LocalRuntimeProvisioner} that turns project config into startable
 * runtimes. Provider selection lives here because the host is what knows which
 * backends it can supply — the workflow only ever sees `deps.backend`.
 */
import type {
  CancellationToken,
  CommandRunner,
  Diagnostics,
  Progress,
  UserInteraction,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type { AuthSession } from '@microsoft/rayfin-tools-common/_internal/services/auth';
import type {
  DevBackendProvider,
  DevDeps,
  LocalRuntimeProvisioner,
} from '@microsoft/rayfin-tools-common/_internal/workflows/dev';
import {
  type FabricReadinessNotice,
  type CapacityAssignmentMode,
  runFabricReadinessWorkflow,
} from '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness';

import { cliCommandRunner } from '../../adapters/runner.js';
import { getFabricSettings } from '../../config/constants.js';
import {
  createCliFabricClient,
  createCliRayfinWorkloadClient,
} from '../../external-services/fabric/index.js';
import {
  createDockerDevProvider,
  fetchLocalPublishableKey,
} from '../../local-services/dev/docker-dev-provider.js';
import {
  createFabricDevProvider,
  type FabricDevReadiness,
} from '../../local-services/dev/fabric-dev-provider.js';
import {
  type FunctionsPrereqOutcome,
  createCliLocalRuntimeProvisioner,
} from '../../local-services/dev/local-runtime-provisioner.js';
import {
  createCliDataService,
  createCliDeploymentRegistryService,
  createCliDevRedirectService,
  createCliFrameworkEnvService,
} from '../../rayfin-services/index.js';
import { getAmbientWorkspaceId } from '../../utils/ambient-env.js';
import { updateEnvVariables } from '../../utils/env-file-utils.js';

/** Supported `--provider` values. */
export const DEV_PROVIDERS = ['fabric', 'docker'] as const;
export type DevProviderId = (typeof DEV_PROVIDERS)[number];

/** Inputs for assembling {@link DevDeps}. */
export interface CreateDevDepsOptions {
  diagnostics: Diagnostics;
  /** Selected provider id (default `fabric`). */
  provider: DevProviderId;
  /** The loaded `rayfin.yml`. */
  config: RayfinConfig;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Push-style progress impl resolved from the host's rendering mode. */
  progress: Progress;
  /**
   * Command runner for the local runtimes. Defaults to the plain CLI runner;
   * the v2 host injects a streaming runner so frontend output is visible.
   */
  runner?: CommandRunner;
  /** Fabric workspace display name (`--workspace`) for a first-run backend. */
  workspace?: string;
  /** Fabric workspace GUID (`--workspace-id`); takes precedence over the ambient env. */
  workspaceId?: string;
  /** Explicit Fabric capacity selected for an unassigned workspace. */
  capacityId?: string;
  /** Authenticated Fabric session resolved once by the command host. */
  session?: AuthSession;
  /** Native cancellation forwarded to Fabric HTTP requests. */
  abortSignal?: AbortSignal;
  /** Cooperative cancellation forwarded to the readiness workflow. */
  cancellationToken?: CancellationToken;
  /** Collects readiness side effects for structured command output. */
  onReadinessNotice?: (notice: FabricReadinessNotice) => void;
  /**
   * Whether to regenerate the framework `.env.local` during local wiring.
   * `false` mirrors `--no-emit-env`; defaults to `true`.
   */
  emitFrameworkEnv?: boolean;
  /** Pre-approve reuse of an existing same-named AppBackend (`--yes`). */
  autoConfirmReuse?: boolean;
  /** Interactive confirmation capability; absent in JSON and non-interactive modes. */
  ui?: UserInteraction;
  /**
   * User-visible progress sink for local-runtime *and* Fabric backend
   * provisioning, wired by the host to the session's output mode. Defaults to a
   * no-op, and `json`/`silent` suppress it — so it is never the only disclosure
   * of a durable write.
   */
  notify?: (message: string) => void;
  /** Functions-build stdout sink selected by the active output mode. */
  onBuildStdout?: (chunk: string) => void;
  /** Functions-build stderr sink selected by the active output mode. */
  onBuildStderr?: (chunk: string) => void;
}

/**
 * Build the selected {@link DevBackendProvider}. The Fabric provider
 * authenticates and wires the workload/registry services; the Docker provider
 * wires only the local data/framework services.
 */
async function createProvider(
  options: CreateDevDepsOptions,
  reservedPorts: Set<number>
): Promise<DevBackendProvider> {
  const { provider, config, projectRoot } = options;
  const emitFrameworkEnv = options.emitFrameworkEnv ?? true;
  const persistPublicEnv = (
    rayfinDir: string,
    vars: { key: string; value: string | null }[]
  ): Promise<void> => updateEnvVariables(rayfinDir, vars);

  if (provider === 'docker') {
    return createDockerDevProvider({
      data: createCliDataService({
        diagnostics: options.diagnostics,
        captureOutput: false,
      }),
      devRedirect: createCliDevRedirectService(reservedPorts),
      frameworkEnv: createCliFrameworkEnvService(),
      config,
      projectRoot,
      reservedPorts,
      persistPublicEnv,
      fetchLocalPublishableKey,
      emitFrameworkEnv,
    });
  }

  if (!options.session) {
    throw new Error(
      'A resolved authenticated session is required for the Fabric dev provider.'
    );
  }
  const fabric = createCliFabricClient(options.session.token, {
    diagnostics: options.diagnostics,
    signal: options.abortSignal,
  });
  const notify = options.notify ?? (() => {});
  const readiness: FabricDevReadiness = {
    async prepare(workspaceId) {
      const capacityAssignmentMode: CapacityAssignmentMode =
        options.capacityId || options.autoConfirmReuse === true
          ? 'automatic'
          : 'confirm';
      const result = await runFabricReadinessWorkflow(
        {
          projectId: config.id,
          workspaceId,
          capacityId: options.capacityId,
          capacityAssignmentMode,
        },
        {
          fabric,
          logger: {
            log: notify,
            warn: notify,
            error: notify,
          },
          progress: options.progress,
          ui: options.ui,
          premiumCapacitySelection: options.ui ? 'prompt' : 'fallback',
          signal: options.cancellationToken,
        }
      );
      const notices =
        result.status === 'ok' ? result.data.notices : result.notices;
      for (const notice of notices ?? []) {
        options.onReadinessNotice?.(notice);
      }
      if (result.status === 'cancelled') {
        return { status: 'cancelled' };
      }
      if (result.status === 'failed') {
        return {
          status: 'unavailable',
          code: 'fabric-readiness:failed',
          message: result.error.message,
        };
      }
      const prepared = result.data.result;
      if (prepared.status === 'assignment-declined') {
        return { status: 'declined' };
      }
      if (prepared.status !== 'ready') {
        return {
          status: 'unavailable',
          code: `fabric-readiness:${prepared.reason}`,
          message: prepared.message,
        };
      }
      notify(
        `Fabric readiness confirmed for workspace "${prepared.workspace.displayName}".`
      );
      return {
        status: 'ready',
        workspace: prepared.workspace,
      };
    },
  };
  return createFabricDevProvider({
    fabric,
    workload: createCliRayfinWorkloadClient(
      options.session.token,
      options.diagnostics
    ),
    data: createCliDataService({
      diagnostics: options.diagnostics,
      captureOutput: false,
    }),
    registry: createCliDeploymentRegistryService(),
    devRedirect: createCliDevRedirectService(reservedPorts),
    frameworkEnv: createCliFrameworkEnvService(),
    config,
    projectRoot,
    targetWorkspaceId:
      options.workspaceId ??
      (options.workspace ? undefined : (getAmbientWorkspaceId() ?? undefined)),
    // No default: the provider prompts (or fails closed) when neither a flag,
    // the ambient env, nor the registry names a workspace.
    targetWorkspaceName: options.workspace,
    tenantId: options.session.tenantId,
    portalUrl: getFabricSettings().fabricPortalUrl.replace(/\/+$/, ''),
    autoConfirmReuse: options.autoConfirmReuse,
    requestedCapacityId: options.capacityId,
    ui: options.ui,
    notify: options.notify,
    readiness,
    isCancelled: () =>
      options.abortSignal?.aborted === true ||
      options.cancellationToken?.isCancellationRequested === true,
    persistPublicEnv,
    emitFrameworkEnv,
  });
}

/** Build the `dev` workflow's dependency slice for the CLI host. */
export async function createDevDeps(
  options: CreateDevDepsOptions
): Promise<DevDeps> {
  const reservedPorts = new Set<number>();
  const backend = await createProvider(options, reservedPorts);
  return {
    diagnostics: options.diagnostics,
    backend,
    runtimes: createLocalRuntimes(options, reservedPorts),
    runner: options.runner ?? cliCommandRunner,
    progress: options.progress,
  };
}

/**
 * Build the host strategy that reserves and prepares the local runtimes this
 * session runs (the frontend dev server, and the functions host when
 * `services.functions.enabled`).
 */
function createLocalRuntimes(
  options: CreateDevDepsOptions,
  reservedPorts: Set<number>
): LocalRuntimeProvisioner {
  return createCliLocalRuntimeProvisioner({
    config: options.config,
    projectRoot: options.projectRoot,
    reservedPorts,
    ensureFunctionsPrereqs,
    notify: options.notify,
    onBuildStdout: options.onBuildStdout,
    onBuildStderr: options.onBuildStderr,
  });
}

/**
 * Detect the functions toolchain without changing host state.
 *
 * Bare `dev` never prompts for an install: the consent-gated installer stays in
 * `rayfin dev functions apply`, so a missing toolchain is a typed failure that
 * points there instead of an inline prompt in a session that may be running
 * non-interactively.
 */
async function ensureFunctionsPrereqs(): Promise<FunctionsPrereqOutcome> {
  // Imported lazily: the prereqs module pulls in `inquirer`, which is far too
  // heavy to load while merely registering the `dev` command tree.
  const { inspectFunctionsPrereqs, refreshPathFromOs } =
    await import('../../utils/functions-prereqs.js');

  let report = inspectFunctionsPrereqs();
  if (!report.funcCoreTools.ok) {
    // The user may have installed Core Tools in a sibling shell since this
    // process started; re-read PATH from the OS before failing them.
    refreshPathFromOs();
    report = inspectFunctionsPrereqs();
  }

  if (!report.node.ok) {
    return {
      status: 'unavailable',
      code: 'functions-node-unsupported',
      message: `Node.js ${report.node.minimumMajor ?? 20} or later is required to run functions locally.`,
    };
  }
  if (!report.funcCoreTools.ok) {
    return {
      status: 'unavailable',
      code: 'functions-core-tools-missing',
      message: 'Azure Functions Core Tools is not installed.',
    };
  }
  return { status: 'ok' };
}
