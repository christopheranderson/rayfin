/**
 * `up` workflow step: deploy serverless functions to the workload.
 *
 * Thin orchestration over the {@link FunctionsService}: it builds the workload
 * deploy URL from the resolved target and delegates build/package/deploy. The
 * deploy endpoint and moniker header are derived here so the service stays
 * endpoint-agnostic (mirroring `deploy-static`).
 *
 * Feature-flag gating lives in the workflow (Layer 2), not in this step — the
 * step takes the already-gated capability as a dependency and runs
 * unconditionally when called.
 */
import type { FunctionsConfig } from '../../../config/index.js';
import type { WorkloadTarget } from '../../../external/fabric/index.js';
import type { FunctionsService } from '../../../services/functions/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link deployFunctions}. */
export interface DeployFunctionsInput {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** The `services.functions` block from `rayfin.yml`. */
  config: FunctionsConfig;
  /** Resolved workload coordinates for the deployed item. */
  target: WorkloadTarget;
}

/** Capabilities {@link deployFunctions} composes. */
export interface DeployFunctionsDeps {
  functions: FunctionsService;
}

/**
 * Deploy the configured functions to the deployed item's workload.
 *
 * @throws When the build or deploy fails (functions failures are fatal to the
 *   deployment, mirroring the legacy behavior).
 */
export const deployFunctions: Step<
  DeployFunctionsInput,
  void,
  DeployFunctionsDeps
> = async (input, { functions }) => {
  await functions.deploy({
    projectRoot: input.projectRoot,
    config: input.config,
    deployUrl: `${input.target.itemEndpoint}/__private/functions/deploy`,
    itemId: input.target.itemId,
    authorizationHeader: input.target.authorizationHeader,
  });
};
