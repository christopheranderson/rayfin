import { FabricApiClient } from './client.js';

/**
 * A resolved Kusto query target: the cluster query endpoint plus the KQL
 * database to run against. Mirrors {@link ResolvedConnection} from
 * `sql-endpoint.ts`.
 */
export interface ResolvedKustoEndpoint {
  /**
   * Absolute https cluster query URI, e.g.
   * `https://<id>.z<n>.kusto.fabric.microsoft.com`.
   */
  queryServiceUri: string;
  /** KQL database name to run the query against. */
  databaseName: string;
  /**
   * The item id the endpoint was ultimately resolved from. Differs from the
   * input `itemId` only when an Eventhouse is resolved down to its single
   * child KQL database.
   */
  resolvedItemId: string;
}

/** Fabric `Get Eventhouse` response — only the fields we read. */
interface EventhouseResponse {
  displayName?: string;
  properties?: {
    queryServiceUri?: string;
    databasesItemIds?: string[];
  };
}

/** Fabric `Get KQL Database` response — only the fields we read. */
interface KqlDatabaseResponse {
  displayName?: string;
  properties?: {
    queryServiceUri?: string;
    parentEventhouseItemId?: string;
  };
}

/**
 * Resolves the Kusto cluster query endpoint + database name for a Fabric
 * Eventhouse or KQL Database item, so `rayfin connector add` can bake them
 * into connector config. Routes by item type, mirroring
 * {@link SqlEndpointManager}.
 *
 * Only reads item properties, so the Fabric control-plane token already held
 * by {@link FabricApiClient} is sufficient — no Kusto data-plane token is
 * acquired here (that is an invoke-time concern handled by the connector's
 * delegated auth model).
 */
export class KustoEndpointManager extends FabricApiClient {
  /**
   * Resolve the query endpoint + database for a Kusto item, picking the right
   * Fabric API based on the item `type` returned by the Get Item API.
   */
  async resolve(
    workspaceId: string,
    itemId: string,
    itemType: string
  ): Promise<ResolvedKustoEndpoint> {
    switch (itemType) {
      case 'Eventhouse':
        return this.resolveEventhouse(workspaceId, itemId);
      case 'KQLDatabase':
        return this.resolveKqlDatabase(workspaceId, itemId);
      default:
        throw new Error(
          `Unsupported item type "${itemType}" for Kusto connector. ` +
            `Supported types: Eventhouse, KQLDatabase.`
        );
    }
  }

  /**
   * Resolve an Eventhouse. The cluster URI lives on the Eventhouse itself.
   * When the Eventhouse hosts exactly one KQL database we resolve that child
   * for an exact database name. A zero- or multi-database Eventhouse has no
   * single unambiguous database to bind to, so we fail with an actionable
   * message rather than guessing — pointing `rayfin connector add` at a
   * specific KQL Database item instead.
   */
  private async resolveEventhouse(
    workspaceId: string,
    eventhouseId: string
  ): Promise<ResolvedKustoEndpoint> {
    const eventhouse = await this.request<EventhouseResponse>(
      `/workspaces/${workspaceId}/eventhouses/${eventhouseId}`
    );

    const queryServiceUri = eventhouse.properties?.queryServiceUri;
    if (!queryServiceUri) {
      throw new Error(
        `Could not resolve queryServiceUri for Eventhouse "${eventhouseId}".`
      );
    }

    const databaseIds = eventhouse.properties?.databasesItemIds ?? [];
    if (databaseIds.length === 1) {
      // Unambiguous: resolve the single child KQL database for its real name.
      return this.resolveKqlDatabase(workspaceId, databaseIds[0]!);
    }

    // Ambiguous / empty: never fall back to the Eventhouse's own display name,
    // which is not a database and would only surface much later as a query
    // error against a database that does not exist.
    if (databaseIds.length > 1) {
      throw new Error(
        `Eventhouse "${eventhouseId}" hosts ${databaseIds.length} databases. ` +
          `Point \`rayfin connector add\` at a specific KQL Database item instead.`
      );
    }
    throw new Error(
      `Eventhouse "${eventhouseId}" has no KQL databases. ` +
        `Create a KQL Database in it, then point \`rayfin connector add\` at that item.`
    );
  }

  /**
   * Resolve a KQL Database. `queryServiceUri` is normally on the item itself;
   * if absent we hop once to the parent Eventhouse (mirrors the Lakehouse →
   * SQL-endpoint hop in `sql-endpoint.ts`). The Kusto database name is the
   * item's `displayName`.
   */
  private async resolveKqlDatabase(
    workspaceId: string,
    kqlDatabaseId: string
  ): Promise<ResolvedKustoEndpoint> {
    const database = await this.request<KqlDatabaseResponse>(
      `/workspaces/${workspaceId}/kqlDatabases/${kqlDatabaseId}`
    );

    const databaseName = database.displayName;
    if (!databaseName) {
      throw new Error(
        `Could not resolve database name for KQL Database "${kqlDatabaseId}".`
      );
    }

    let queryServiceUri = database.properties?.queryServiceUri;
    const parentEventhouseId = database.properties?.parentEventhouseItemId;
    if (!queryServiceUri && parentEventhouseId) {
      const parent = await this.request<EventhouseResponse>(
        `/workspaces/${workspaceId}/eventhouses/${parentEventhouseId}`
      );
      queryServiceUri = parent.properties?.queryServiceUri;
    }

    if (!queryServiceUri) {
      throw new Error(
        `Could not resolve queryServiceUri for KQL Database "${kqlDatabaseId}".`
      );
    }

    return {
      queryServiceUri,
      databaseName,
      resolvedItemId: kqlDatabaseId,
    };
  }
}

export default KustoEndpointManager;
