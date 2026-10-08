/**
 * `up` workflow step: emit `rayfin.config.json` before the static build.
 *
 * Written into the static-hosting `public/` directory so the subsequent build
 * bundles it alongside the compiled SPA. The served app fetches it at runtime
 * via `loadRayfinConfig()`, which wins over build-time `VITE_*` values, so a
 * promoted artifact always talks to the stage it was promoted into.
 *
 * Emission failures are fatal (thrown): a deploy without runtime config would
 * silently retain the source-stage backend after promotion, so this step
 * fails the same way a build/deploy failure does rather than warning and
 * continuing.
 */
import type { StaticHostingConfig } from '../../../config/index.js';
import type { WorkloadTarget } from '../../../external/fabric/index.js';
import type {
  RuntimeConfigService,
  WriteRuntimeConfigResult,
} from '../../../services/runtime-config/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link emitRuntimeConfig}. */
export interface EmitRuntimeConfigInput {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** The `services.staticHosting` block from `rayfin.yml`. */
  config: StaticHostingConfig;
  /** Resolved workload coordinates for the deployed item. */
  target: WorkloadTarget;
  /** Fabric workspace GUID. */
  workspaceId: string;
  /** Publishable key issued for the deployment, when available. */
  publishableKey?: string;
  /** Bare Fabric portal origin (no deep-link path). */
  portalUrl: string;
  /** Effective Entra tenant id for the deployment, when known. */
  tenantId?: string;
}

/** Capabilities {@link emitRuntimeConfig} composes. */
export interface EmitRuntimeConfigDeps {
  runtimeConfig: RuntimeConfigService;
}

/**
 * @throws When the file cannot be written (e.g. permissions, invalid path).
 */
export const emitRuntimeConfig: Step<
  EmitRuntimeConfigInput,
  WriteRuntimeConfigResult,
  EmitRuntimeConfigDeps
> = async (input, { runtimeConfig }) => {
  const {
    projectRoot,
    config,
    target,
    workspaceId,
    publishableKey,
    portalUrl,
    tenantId,
  } = input;
  return runtimeConfig.write(projectRoot, config, {
    apiUrl: target.baasEndpoint,
    publishableKey,
    workspaceId,
    itemId: target.itemId,
    portalUrl,
    tenantId,
  });
};
