//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { RayfinClient, resolveRayfinConfig } from '@microsoft/rayfin-client';
import { resolveRayfinFunctionsBaseUrl } from '@microsoft/rayfin-local-dev';

let _client: RayfinClient | undefined;

/**
 * Returns the pre-configured RayfinClient singleton.
 */
export async function getRayfinClient(): Promise<RayfinClient> {
  if (!_client) {
    const apiUrl = import.meta.env.VITE_RAYFIN_API_URL;
    const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY;

    if (!apiUrl || !publishableKey) {
      throw new Error(
        `Missing required env vars for creating rayfin client - run 'npx rayfin up'`
      );
    }

    // resolved.baseUrl/publishableKey are always set: apiUrl/publishableKey are
    // validated non-empty above, so the resolve step can only overlay on top of them.
    const resolved = await resolveRayfinConfig({
      apiUrl,
      publishableKey,
      workspaceId: import.meta.env.VITE_FABRIC_WORKSPACE_ID,
      itemId: import.meta.env.VITE_FABRIC_ITEM_ID,
      portalUrl: import.meta.env.VITE_FABRIC_PORTAL_URL,
    });

    _client = new RayfinClient({
      baseUrl: resolved.baseUrl!,
      publishableKey: resolved.publishableKey!,
      authStorage: true,
      useProxy: false,
      functionsBaseUrl: resolveRayfinFunctionsBaseUrl(),
      runtimeConfig: resolved.runtimeConfig,
    });
  }

  return _client;
}
