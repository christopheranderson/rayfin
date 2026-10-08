/**
 * Assembles the {@link UpDeps} capability slice the `up` workflow declares,
 * from the CLI host's adapter impls and product-service factories.
 *
 * This is the `up`-specific view of the Layer 1 host container: it wires the
 * Fabric clients (from an acquired bearer token), the Node-backed product
 * services, push-style progress, and the resolved user-interaction adapter.
 * The host resolves `ui` (see `createConsole` in `up-v2.ts`) so the prompt
 * adapter can share the spinner; a non-interactive host passes `undefined`,
 * which the workflow treats as "forbid unconsented item reuse" (matching the
 * legacy non-interactive hard-fail).
 */
import {
  abortSignalFromCancellationToken,
  type CancellationToken,
  type Diagnostics,
  type Progress,
  type TelemetryHandle,
  type UserInteraction,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { DeploymentTelemetryCollector } from '@microsoft/rayfin-tools-common/_internal/services/project-telemetry';
import type { UpDeps } from '@microsoft/rayfin-tools-common/_internal/workflows/up';

import {
  createCliFabricClient,
  createCliRayfinWorkloadClient,
} from '../../external-services/fabric/index.js';
import {
  createCliAuthSdkService,
  createCliConnectorService,
  createCliDataService,
  createCliDeploymentRegistryService,
  createCliDevRedirectService,
  createCliFrameworkEnvService,
  createCliFunctionsService,
  createCliPackageInventoryService,
  createCliRuntimeConfigService,
  createCliStaticHostingService,
  createCliStorageService,
} from '../../rayfin-services/index.js';

/** Inputs for assembling {@link UpDeps}. */
export interface CreateUpDepsOptions {
  /** Acquired Fabric bearer token, shared by the Fabric and workload clients. */
  accessToken: string;
  /** Push-style progress impl resolved from the host's rendering mode. */
  progress: Progress;
  /**
   * Resolved user-interaction adapter, or `undefined` for a non-interactive
   * host. When present it is spinner-aware (suspends progress while prompting).
   */
  ui?: UserInteraction;
  diagnostics: Diagnostics;
  /** Invocation-scoped telemetry enrichment handle. */
  telemetry: TelemetryHandle;
  /** Project provenance and package inventory source. */
  projectTelemetry: DeploymentTelemetryCollector;
  /** Invocation cancellation shared with the workflow. */
  signal?: CancellationToken;
}

/** CLI-owned workflow dependencies with invocation-lifetime cleanup. */
export interface CliUpDeps extends UpDeps {
  dispose(): void;
}

/** Build the `up` workflow's dependency slice for the CLI host. */
export function createUpDeps(options: CreateUpDepsOptions): CliUpDeps {
  const {
    accessToken,
    progress,
    ui,
    diagnostics,
    telemetry,
    projectTelemetry,
    signal,
  } = options;
  const requestCancellation = signal
    ? abortSignalFromCancellationToken(signal)
    : undefined;

  return {
    diagnostics,
    fabric: createCliFabricClient(accessToken, {
      diagnostics,
      signal: requestCancellation?.signal,
    }),
    workload: createCliRayfinWorkloadClient(accessToken, diagnostics),
    connectors: createCliConnectorService({ diagnostics }),
    data: createCliDataService({ diagnostics, captureOutput: true }),
    storage: createCliStorageService({ diagnostics }),
    staticHosting: createCliStaticHostingService({
      diagnostics,
      captureOutput: true,
    }),
    runtimeConfig: createCliRuntimeConfigService(),
    registry: createCliDeploymentRegistryService(),
    frameworkEnv: createCliFrameworkEnvService(),
    functions: createCliFunctionsService({ diagnostics, captureOutput: true }),
    devRedirect: createCliDevRedirectService(),
    authSdk: createCliAuthSdkService(),
    packageInventory: createCliPackageInventoryService(),
    telemetry,
    projectTelemetry,
    progress,
    ui,
    signal,
    dispose: () => requestCancellation?.dispose(),
  };
}
