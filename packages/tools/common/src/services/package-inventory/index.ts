/**
 * Package-inventory product-service contract (Layer 3).
 *
 * Reports the versions of the Rayfin packages a deploy would ship, so the
 * `packageVersions` a runtime-settings write declares is explicit workflow data
 * rather than something the workload client discovers behind the caller's back.
 *
 * Keyed on what is *installed*, not on what the manifest declares, so it agrees
 * with {@link AuthSdkService}: that service upgrades a transitively installed
 * SDK too, and a record that omitted it would describe a deployment that did
 * not happen.
 *
 * Node-free: the host implementation owns module resolution and filesystem
 * access (`cli/src/rayfin-services/package-inventory.ts`).
 */
import type { RayfinConfig } from '../../config/index.js';

/** Inputs for {@link PackageInventoryService.resolveDeployPackageVersions}. */
export interface DeployPackageVersionsRequest {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /**
   * Current `services` config, used to locate the frontend package whose
   * installed dependencies this deploy actually ships.
   */
  services: RayfinConfig['services'];
}

export interface PackageInventoryService {
  /**
   * Resolve the Rayfin package versions this deploy would ship, keyed by npm
   * package name. Packages whose version cannot be resolved are omitted rather
   * than declared as unknown; an empty inventory resolves to an empty map.
   *
   * The deploy client's own identity is *not* included — that is added at the
   * wire boundary so nothing assembled here can misreport it.
   */
  resolveDeployPackageVersions(
    request: DeployPackageVersionsRequest
  ): Promise<Record<string, string>>;
}
