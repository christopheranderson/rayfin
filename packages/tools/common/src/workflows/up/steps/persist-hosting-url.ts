/**
 * `up` workflow step: persist the static hosting URL after a static deploy.
 *
 * Delegates to the {@link StaticHostingService} to register the hosting URL as
 * an allowed redirect URI, re-apply the updated runtime settings, and record
 * the URL in the deployment registry. The settings re-apply is the *second*
 * runtime-settings send (`runtime-settings-patch`), so this step forwards the
 * same `connectors` block as the initial apply — keeping connectors present on
 * both POST sites (the carry-forward from #1470).
 *
 * Only runs when a static deploy produced a hosting URL; an excluded or
 * disabled static service skips it.
 */
import type { RayfinConfig } from '../../../config/index.js';
import type {
  RayfinWorkloadClient,
  WorkloadTarget,
} from '../../../external/fabric/index.js';
import type {
  PersistHostingUrlResult,
  StaticHostingService,
} from '../../../services/static-hosting/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link persistHostingUrl}. */
export interface PersistHostingUrlInput {
  /** Resolved workload coordinates for the deployed item. */
  target: WorkloadTarget;
  /** The hosting URL returned by the static deploy. */
  hostingUrl: string;
  /** The `services` block from `rayfin.yml`. */
  services: RayfinConfig['services'];
  /** The `connectors` block, forwarded to the patch POST for parity. */
  connectors?: RayfinConfig['connectors'];
  /** Versions of the Rayfin packages this deploy ships, declared on the wire. */
  packageVersions?: Record<string, string>;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Workspace display name the deployment is keyed under. */
  workspaceName: string;
}

/** Capabilities {@link persistHostingUrl} composes. */
export interface PersistHostingUrlDeps {
  staticHosting: StaticHostingService;
  workload: RayfinWorkloadClient;
}

/**
 * Register the hosting URL, re-apply runtime settings (forwarding connectors),
 * and record the URL. Best-effort local persistence per the service contract.
 *
 * @throws When the redirect-URI settings re-apply rejects.
 */
export const persistHostingUrl: Step<
  PersistHostingUrlInput,
  PersistHostingUrlResult,
  PersistHostingUrlDeps
> = async (input, { staticHosting, workload }) => {
  return staticHosting.persistHostingUrl({
    hostingUrl: input.hostingUrl,
    services: input.services,
    projectRoot: input.projectRoot,
    workspaceName: input.workspaceName,
    postSettings: (updatedServices) =>
      workload.applyRuntimeSettings(input.target, {
        services: updatedServices,
        connectors: input.connectors,
        packageVersions: input.packageVersions,
        label: 'runtime-settings-patch',
      }),
  });
};
