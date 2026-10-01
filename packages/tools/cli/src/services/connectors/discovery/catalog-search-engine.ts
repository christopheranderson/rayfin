import {
  CONNECTOR_CATALOG,
  type ConnectorType,
  type DiscoveredSource,
  type DiscoveryScope,
} from '@microsoft/rayfin-tools-common/_internal/config';

import { FabricApiClient } from '../../fabric/client.js';

import type { DiscoveryEngine, DiscoveryEngineInput } from './engine.js';
import { compareSources } from './registry.js';

/**
 * One entry from the Fabric Catalog Search API (`POST /v1/catalog/search`).
 * `type` is a Fabric `ItemType` (e.g. `Warehouse`), one per discoverable connector type.
 */
export interface ItemCatalogEntry {
  id: string;
  type: string;
  catalogEntryType?: string;
  displayName: string;
  description?: string;
  hierarchy?: {
    workspace?: { id: string; displayName: string };
  };
}

/**
 * Narrow client contract the engine depends on, so unit tests can inject
 * canned catalog entries without a live Fabric call.
 */
export interface CatalogSearchClient {
  /** Every catalog entry matching `itemTypes` (and `search`, if given), security-trimmed to the caller. Paginated internally. */
  searchItems(
    itemTypes: readonly string[],
    search?: string
  ): Promise<ItemCatalogEntry[]>;
}

/**
 * Fabric Catalog Search REST client: a single paginated cross-workspace
 * `POST /catalog/search`, reusing {@link FabricApiClient}'s auth/error handling.
 */
export class FabricCatalogClient
  extends FabricApiClient
  implements CatalogSearchClient
{
  //must be between 1 to 1000, as per https://learn.microsoft.com/en-us/rest/api/fabric/core/catalog/search?tabs=HTTP
  private static readonly PAGE_SIZE = 100;

  public async searchItems(
    itemTypes: readonly string[],
    search = ''
  ): Promise<ItemCatalogEntry[]> {
    // Item types are static catalog constants, never user input, so the
    // OData filter is built by simple concatenation (`Type` is case-sensitive).
    const filter = itemTypes.map((t) => `Type eq '${t}'`).join(' or ');

    const entries: ItemCatalogEntry[] = [];
    let continuationToken: string | undefined;
    do {
      // The continuation token already encodes the original search/filter;
      // resending them alongside it triggers a 400, so only pageSize is sent once paginating.
      const body: Record<string, unknown> = continuationToken
        ? { pageSize: FabricCatalogClient.PAGE_SIZE, continuationToken }
        : {
            search,
            pageSize: FabricCatalogClient.PAGE_SIZE,
            ...(filter ? { filter } : {}),
          };

      const page = await this.request<{
        value?: ItemCatalogEntry[];
        continuationToken?: string | null;
      }>('/catalog/search', 'POST', body);

      entries.push(...(page.value ?? []));
      continuationToken = page.continuationToken ?? undefined;
    } while (continuationToken);

    return entries;
  }
}

/**
 * Resolve discoverable Fabric item types for `types`, plus a reverse index
 * back to connector type. First connector type wins on collisions.
 */
function buildItemTypeIndex(types: readonly ConnectorType[]): {
  itemTypes: string[];
  connectorFor: Map<string, ConnectorType>;
} {
  const connectorFor = new Map<string, ConnectorType>();
  const itemTypes = new Set<string>();
  for (const type of types) {
    const meta = CONNECTOR_CATALOG[type];
    if (!meta?.discoverable) continue;
    const itemType = meta.fabricItemType;
    itemTypes.add(itemType);
    if (!connectorFor.has(itemType)) connectorFor.set(itemType, type);
  }
  return { itemTypes: [...itemTypes], connectorFor };
}

/** Every connector type marked discoverable. */
function allDiscoverableConnectorTypes(): ConnectorType[] {
  return (Object.keys(CONNECTOR_CATALOG) as ConnectorType[]).filter(
    (t) => !!CONNECTOR_CATALOG[t].discoverable
  );
}

/**
 * Narrow Catalog Search's tenant-wide result set to the requested
 * {@link DiscoveryScope}, client-side (the API only filters by `Type`).
 */
function workspacePredicate(
  scope: DiscoveryScope
): (workspaceId: string) => boolean {
  if (scope.workspaceId) {
    const only = scope.workspaceId;
    return (id) => id === only;
  }
  if (scope.workspaceIds && scope.workspaceIds.length > 0) {
    const set = new Set(scope.workspaceIds);
    return (id) => set.has(id);
  }
  return () => true;
}

/**
 * Cross-workspace discovery via the Fabric Catalog Search API: one
 * paginated call replaces the per-workspace {@link FanoutDiscoveryEngine} fan-out.
 */
export class CatalogSearchDiscoveryEngine implements DiscoveryEngine {
  public readonly name = 'catalog-search';

  public constructor(private readonly client: CatalogSearchClient) {}

  public async discover({
    request,
    types,
  }: DiscoveryEngineInput): Promise<DiscoveredSource[]> {
    const targetTypes =
      types && types.length > 0 ? types : allDiscoverableConnectorTypes();

    const { itemTypes, connectorFor } = buildItemTypeIndex(targetTypes);
    if (itemTypes.length === 0) return [];

    // Send the query server-side too (narrows the response), then still
    // apply the substring check locally to keep the documented contract exact.
    const entries = await this.client.searchItems(itemTypes, request.query);
    const inScope = workspacePredicate(request.scope);
    const query = request.query.toLowerCase();

    const sources: DiscoveredSource[] = [];
    for (const entry of entries) {
      const workspaceId = entry.hierarchy?.workspace?.id;
      if (!workspaceId || !inScope(workspaceId)) continue;

      const connectorType = connectorFor.get(entry.type);
      if (!connectorType) continue;

      if (query && !entry.displayName.toLowerCase().includes(query)) continue;

      const meta = CONNECTOR_CATALOG[connectorType];
      sources.push({
        connectorType,
        itemType: entry.type,
        workspaceId,
        workspaceName: entry.hierarchy?.workspace?.displayName,
        itemId: entry.id,
        displayName: entry.displayName,
        capabilities: {
          operations: meta.allowedOperations,
          defaultAuth: meta.defaultAuth,
          requiresVersion: meta.requiresVersion,
        },
        // Catalog Search cannot determine workspace role; leave unset (fan-out sets it).
      });
    }

    return sources.sort(compareSources);
  }
}

export default CatalogSearchDiscoveryEngine;
