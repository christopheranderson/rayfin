/**
 * CLI implementation of the {@link PackageInventoryService} product-service
 * contract.
 *
 * Resolves the Rayfin package versions a deploy would ship so the workflow can
 * declare them explicitly on the runtime-settings write, rather than having the
 * workload client discover them from the filesystem on its own.
 *
 * A thin delegation to `utils/package-versions.ts`, which owns the resolution
 * itself (installed version rather than declared range, including the pnpm
 * virtual-store and transitive-consumer layouts).
 */
import type {
  DeployPackageVersionsRequest,
  PackageInventoryService,
} from '@microsoft/rayfin-tools-common/_internal/services/package-inventory';

import { resolveDeployPackageVersions } from '../utils/package-versions.js';

/** Construct the CLI-host {@link PackageInventoryService}. */
export function createCliPackageInventoryService(): PackageInventoryService {
  return {
    async resolveDeployPackageVersions(
      request: DeployPackageVersionsRequest
    ): Promise<Record<string, string>> {
      return (
        resolveDeployPackageVersions(request.projectRoot, request.services) ??
        {}
      );
    },
  };
}
