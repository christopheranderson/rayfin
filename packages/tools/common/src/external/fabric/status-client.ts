import type { Http } from '../../adapters/http.js';
import { MONIKER_HEADER } from '../../fabric.js';

import type { FabricWorkspace } from './client.js';
import { FabricHttpClient } from './http-client.js';
import { parsePublishableKeyResponse } from './publishable-key.js';

/** Facts about a private management request, not application runtime health. @internal */
export interface ManagementEndpointHealth {
  url: string;
  reachable: boolean;
  httpStatus?: number;
  authenticated?: boolean;
  publishableKey?: string;
  metadataError?: 'unexpected-format';
  errorCode?:
    | 'http'
    | 'redirect'
    | 'timeout'
    | 'connection-refused'
    | 'network';
  error?: string;
}

/** Read-only Fabric operations needed for deployment inspection. @internal */
export interface FabricStatusClient {
  getWorkspace(workspaceId: string): Promise<FabricWorkspace>;
  getItem(
    workspaceId: string,
    itemId: string
  ): Promise<{
    id: string;
    displayName: string;
    type: string;
  } | null>;
  listDatabases(workspaceId: string): Promise<
    {
      id: string;
      displayName: string;
    }[]
  >;
  checkManagementEndpoint(
    workspaceId: string,
    itemId: string
  ): Promise<ManagementEndpointHealth>;
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/** Construct read-only operations over the shared Fabric transport. @internal */
export function createFabricStatusClient(
  http: Http,
  apiBaseUrl: string
): FabricStatusClient {
  const baseUrl = stripTrailingSlashes(apiBaseUrl);
  const transport = new FabricHttpClient({ http, baseUrl });
  const workspacePath = (workspaceId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}`;
  return {
    getWorkspace: (workspaceId) =>
      transport.request<FabricWorkspace>(workspacePath(workspaceId)),
    getItem: (workspaceId, itemId) =>
      transport.request(
        `${workspacePath(workspaceId)}/items/${encodeURIComponent(itemId)}`
      ),
    async listDatabases(workspaceId) {
      const response = await transport.request<{
        value: { id: string; displayName: string }[];
      }>(`${workspacePath(workspaceId)}/sqlDatabases`);
      return response.value;
    },
    checkManagementEndpoint: (workspaceId, itemId) =>
      checkManagementEndpoint(
        {
          itemEndpoint: `${baseUrl}${workspacePath(workspaceId)}/appBackends/${encodeURIComponent(itemId)}`,
          itemId,
        },
        http
      ),
  };
}

/** Inspect management access using an authenticated host HTTP adapter. @internal */
export async function checkManagementEndpoint(
  target: { itemEndpoint: string; itemId: string },
  http: Http
): Promise<ManagementEndpointHealth> {
  const url = `${stripTrailingSlashes(target.itemEndpoint)}/__private/publishable-key`;
  const health: ManagementEndpointHealth = { url, reachable: false };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await http.fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        [MONIKER_HEADER]: target.itemId,
        Accept: 'application/json',
      },
    });
    health.reachable = true;
    if (response.type === 'opaqueredirect') {
      return {
        ...health,
        errorCode: 'redirect',
        error:
          'Management endpoint redirected; response details are unavailable in this host.',
      };
    }
    health.httpStatus = response.status;
    if (!response.ok) {
      return {
        ...health,
        authenticated:
          response.status === 401 || response.status === 403
            ? false
            : undefined,
        errorCode: 'http',
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }
    health.authenticated = true;
    const publishableKey =
      parsePublishableKeyResponse(await response.text())?.trim() || undefined;
    return {
      ...health,
      publishableKey,
      metadataError: publishableKey ? undefined : 'unexpected-format',
    };
  } catch (error) {
    const failure = (error ?? {}) as {
      name?: string;
      message?: string;
      cause?: { code?: string };
    };
    if (failure.name === 'AbortError') {
      return {
        ...health,
        errorCode: 'timeout',
        error: 'Request timed out (10s)',
      };
    }
    if (
      failure.cause?.code === 'ECONNREFUSED' ||
      failure.message?.includes('ECONNREFUSED')
    ) {
      return {
        ...health,
        errorCode: 'connection-refused',
        error: 'Connection refused',
      };
    }
    return {
      ...health,
      errorCode: 'network',
      error: failure.message || 'Request failed',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
