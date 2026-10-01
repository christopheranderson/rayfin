/**
 * CLI implementation of the {@link RayfinWorkloadClient} operations interface.
 *
 * A thin delegation to the existing {@link RayfinItemManager} (endpoint and
 * extended-property resolution, auth header) and the CLI's workload utils
 * ({@link fetchPublishableKey}, {@link postRuntimeSettings}). The host injects
 * an acquired bearer token; assembling the client is a host concern that never
 * reaches the universal steps consuming the interface.
 *
 * Legacy terminal banners stay silent; operational detail uses the injected
 * diagnostics adapter and the workflow owns progress rendering.
 */
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type {
  ApplyRuntimeSettingsInput,
  RayfinWorkloadClient,
  WorkloadTarget,
} from '@microsoft/rayfin-tools-common/_internal/external/fabric';

import { MONIKER_HEADER } from '../../config/constants.js';
import { RayfinItemManager } from '../../services/fabric/rayfin-item.js';
import { getPublishableKey as fetchPublishableKey } from '../../utils/publishable-key-utils.js';
import { postRuntimeSettings } from '../../utils/runtime-settings.js';

/** Discards diagnostic output; the driving workflow step owns progress rendering. */
const silent = (): void => {};

/**
 * Construct the CLI-host {@link RayfinWorkloadClient} from an acquired Fabric
 * bearer token (e.g. the token returned by `ensureAuthenticated()`).
 *
 * Package discovery is deliberately not done here: the versions a deploy
 * declares arrive on {@link ApplyRuntimeSettingsInput}, so they are visible in
 * the step contract and this client applies no project policy of its own when
 * another workflow reuses it.
 */
export function createCliRayfinWorkloadClient(
  accessToken: string,
  diagnostics?: Diagnostics
): RayfinWorkloadClient {
  const items = new RayfinItemManager(accessToken, {
    log: silent,
    warn: silent,
    error: silent,
    diagnostics,
  });
  return {
    async resolveTarget(
      workspaceId: string,
      itemId: string
    ): Promise<WorkloadTarget> {
      const itemEndpoint = items.getRayfinItemEndpoint(workspaceId, itemId);
      const extended = await items.getExtendedProperties(workspaceId, itemId);
      return {
        itemId,
        itemEndpoint,
        baasEndpoint: extended.BaaSEndpoint,
        authorizationHeader: items.getAuthorizationHeader(),
      };
    },
    getPublishableKey(target: WorkloadTarget): Promise<string> {
      return fetchPublishableKey(target.itemEndpoint, target.itemId, {
        authorizationHeader: target.authorizationHeader,
        diagnostics,
      });
    },
    async applyRuntimeSettings(
      target: WorkloadTarget,
      input: ApplyRuntimeSettingsInput
    ): Promise<void> {
      await postRuntimeSettings(
        target.itemEndpoint,
        input.services,
        target.authorizationHeader,
        silent,
        input.label ?? 'runtime-settings',
        { [MONIKER_HEADER]: target.itemId },
        input.connectors,
        input.packageVersions,
        diagnostics
      );
    },
  };
}
