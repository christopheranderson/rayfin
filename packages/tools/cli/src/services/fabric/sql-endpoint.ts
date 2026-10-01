import { FabricApiClient } from './client.js';

export interface ResolvedConnection {
  connectionString: string;
  resolvedItemId: string;
  databaseName?: string;
}

/**
 * Resolves TDS connection strings for Fabric SQL endpoints.
 * Routes to the correct Fabric API based on item type.
 */
export class SqlEndpointManager extends FabricApiClient {
  /**
   * Resolve the TDS connection string based on the item type
   * returned by the Get Item API.
   */
  async getConnectionStringByType(
    workspaceId: string,
    itemId: string,
    itemType: string
  ): Promise<ResolvedConnection> {
    switch (itemType) {
      case 'Lakehouse':
        return this.resolveLakehouse(workspaceId, itemId);
      case 'SQLEndpoint':
        return this.resolveSqlEndpoint(workspaceId, itemId);
      case 'Warehouse':
        return this.resolveWarehouse(workspaceId, itemId);
      case 'SQLDatabase':
        return this.resolveSqlDatabase(workspaceId, itemId);
      default:
        throw new Error(
          `Unsupported item type "${itemType}" for SQL connection. ` +
            `Supported types: Lakehouse, SQLEndpoint, Warehouse, SQLDatabase.`
        );
    }
  }

  private async resolveLakehouse(
    workspaceId: string,
    lakehouseId: string
  ): Promise<ResolvedConnection> {
    const lakehouse = await this.request<{
      properties?: {
        sqlEndpointProperties?: {
          connectionString?: string;
          id?: string;
        };
      };
    }>(`/workspaces/${workspaceId}/lakehouses/${lakehouseId}`);

    const props = lakehouse.properties?.sqlEndpointProperties;
    if (!props?.connectionString || !props?.id) {
      throw new Error(
        'SQL endpoint not found for this Lakehouse. Ensure the Lakehouse has a SQL endpoint enabled.'
      );
    }

    return {
      connectionString: props.connectionString,
      resolvedItemId: props.id,
      databaseName: props.id,
    };
  }

  private async resolveSqlEndpoint(
    workspaceId: string,
    endpointId: string
  ): Promise<ResolvedConnection> {
    const result = await this.request<{ connectionString?: string }>(
      `/workspaces/${workspaceId}/sqlEndpoints/${endpointId}/connectionString`
    );

    if (!result.connectionString) {
      throw new Error('Could not resolve connection string for SQL endpoint.');
    }

    return {
      connectionString: result.connectionString,
      resolvedItemId: endpointId,
      databaseName: endpointId,
    };
  }

  private async resolveWarehouse(
    workspaceId: string,
    warehouseId: string
  ): Promise<ResolvedConnection> {
    const warehouse = await this.request<{
      properties?: { connectionString?: string };
    }>(`/workspaces/${workspaceId}/warehouses/${warehouseId}`);

    if (!warehouse.properties?.connectionString) {
      throw new Error('Could not resolve connection string for Warehouse.');
    }

    return {
      connectionString: warehouse.properties.connectionString,
      resolvedItemId: warehouseId,
      databaseName: warehouseId,
    };
  }

  private async resolveSqlDatabase(
    workspaceId: string,
    databaseId: string
  ): Promise<ResolvedConnection> {
    const db = await this.request<{
      properties?: {
        connectionString?: string;
        serverFqdn?: string;
        databaseName?: string;
      };
    }>(`/workspaces/${workspaceId}/sqlDatabases/${databaseId}`);

    const connStr =
      db.properties?.serverFqdn || db.properties?.connectionString;
    if (!connStr) {
      throw new Error('Could not resolve connection string for SQL Database.');
    }

    return {
      connectionString: connStr,
      resolvedItemId: databaseId,
      databaseName: db.properties?.databaseName,
    };
  }
}
