/**
 * Rayfin workload operations interface (Layer 3 external client).
 *
 * The seam that workflow steps depend on for talking to a *deployed* Rayfin
 * item's workload — distinct from {@link FabricClient}, which covers the
 * control-plane (workspaces, items). Once an item exists, the `up` workflow
 * resolves its workload coordinates ({@link WorkloadTarget}), reads its
 * publishable key, and pushes runtime (service) settings to its private
 * management endpoints (`__private/*`).
 *
 * Endpoint construction, auth-header derivation, retry, and the
 * `connectors`-as-sibling wire shape are host-impl concerns: the CLI builds
 * this from an acquired bearer token (`cli/src/external-services/fabric/`) and
 * delegates to its existing managers and utils. The universal interface never
 * acquires tokens, constructs URLs, or imports Node built-ins.
 *
 * Operations are added as the first consuming step needs them; the current set
 * is shaped by the `up` workflow's `apply-runtime-settings` step.
 */
import type { RayfinConfig } from '../../config/index.js';

/**
 * Resolved coordinates for talking to a deployed Rayfin item's workload.
 *
 * Produced once by {@link RayfinWorkloadClient.resolveTarget} and threaded
 * through the deploy steps so each call hits the same item with the same
 * authorization, without re-resolving endpoints per step.
 */
export interface WorkloadTarget {
  /** Fabric Rayfin item (AppBackend) GUID. */
  itemId: string;
  /**
   * Fabric item management endpoint, e.g.
   * `${fabricApiBaseUrl}/workspaces/<wsId>/appBackends/<itemId>`. Callers
   * append `__private/*` paths to reach the workload's private APIs.
   */
  itemEndpoint: string;
  /** Fully-resolved BaaS workload endpoint reported by the item's extended properties. */
  baasEndpoint: string;
  /** Pre-formatted `Authorization` header value (`Bearer <token>`) for workload calls. */
  authorizationHeader: string;
}

/** Inputs for {@link RayfinWorkloadClient.applyRuntimeSettings}. */
export interface ApplyRuntimeSettingsInput {
  /** The `services` block from `rayfin.yml`, sent as the runtime settings body. */
  services: RayfinConfig['services'];
  /**
   * The `connectors` block from `rayfin.yml`. When non-empty it is merged into
   * the wire payload as a **sibling** of the service keys (not nested under
   * `services`). Omitted or empty connectors leave the payload unchanged.
   */
  connectors?: RayfinConfig['connectors'];
  /**
   * Diagnostic label distinguishing the initial apply (`runtime-settings`,
   * the default) from the post-deploy redirect-URI patch
   * (`runtime-settings-patch`).
   */
  label?: string;
  /**
   * Versions of the Rayfin packages this deploy ships, resolved by the
   * caller's {@link PackageInventoryService} and forwarded verbatim.
   *
   * Explicit input rather than something the client discovers: a client that
   * inspected the filesystem itself would make this required wire data
   * invisible in the step contract, and would apply one workflow's policy to
   * every other caller that reused the client. The client adds only its own
   * identity ({@link DEPLOY_CLIENT_VERSION_KEY}) on top.
   */
  packageVersions?: Record<string, string>;
}

/** Operations over a deployed Rayfin item's workload consumed by workflow steps. */
export interface RayfinWorkloadClient {
  /**
   * Resolve the workload coordinates for a deployed item: its management
   * endpoint, its BaaS endpoint (from the item's extended properties), and the
   * authorization header to use for subsequent workload calls.
   */
  resolveTarget(workspaceId: string, itemId: string): Promise<WorkloadTarget>;

  /**
   * Retrieve the deployed item's publishable key from its private management
   * endpoint. Resolves to an empty string when the item exposes no key.
   */
  getPublishableKey(target: WorkloadTarget): Promise<string>;

  /**
   * Apply runtime (service) settings to the deployed item, merging a non-empty
   * `connectors` block as a sibling of the service keys. Used for both the
   * initial apply and the post-deploy redirect-URI patch; the two are
   * distinguished by {@link ApplyRuntimeSettingsInput.label}. Rejects on a
   * non-transient failure after the host's retry policy is exhausted.
   */
  applyRuntimeSettings(
    target: WorkloadTarget,
    input: ApplyRuntimeSettingsInput
  ): Promise<void>;
}
