/**
 * Functions product-service contract (Layer 3).
 *
 * Builds, packages, and deploys the serverless TypeScript User Data Functions
 * configured via `services.functions` in `rayfin.yml` to a deployed Rayfin
 * item's workload. Workflows declare this in their `Deps`; the orchestration
 * (gating on the `functions` feature flag, sequencing relative to the static
 * deploy) lives in the workflow, not here.
 *
 * Phase 2 backs this with the CLI's existing `deployFunctions` orchestrator;
 * the interface lives here so the `up` workflow (and later other hosts) depend
 * only on the universal contract. It is intentionally Node-free — path
 * resolution and filesystem/network IO live in the host
 * (`cli/src/rayfin-services/`). The deploy endpoint and authorization header
 * are resolved upstream (from the workload target) and passed in, mirroring
 * the static-hosting contract.
 */
import type { FunctionsConfig } from '../../config/index.js';

/** Conventional functions package path when `services.functions.path` is absent. */
export const DEFAULT_FUNCTIONS_PATH = 'rayfin/functions';

/** Inputs for {@link FunctionsService.deploy}. */
export interface DeployFunctionsRequest {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** The `services.functions` block from `rayfin.yml`. */
  config: FunctionsConfig;
  /** Full functions deploy endpoint URL (e.g. `${itemEndpoint}/__private/functions/deploy`). */
  deployUrl: string;
  /** Rayfin item id, sent in the moniker header so the workload authorizes the call. */
  itemId: string;
  /** Pre-formatted `Authorization` header value (`Bearer <token>`). */
  authorizationHeader: string;
}

/** Build, package, and deploy the configured serverless functions. */
export interface FunctionsService {
  /**
   * Build, package, and deploy the configured functions to the deployed Rayfin
   * item's workload. Rejects when the build or deploy fails.
   */
  deploy(request: DeployFunctionsRequest): Promise<void>;
}
