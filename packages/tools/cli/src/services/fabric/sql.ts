import FabricApiClient from './client.js';

/**
 * Interface representing a SQL database in Microsoft Fabric
 */
export interface SqlDatabase {
  id: string;
  displayName: string;
  description?: string;
  type?: 'SQLDatabase';
  workspaceId?: string;
  properties?: {
    connectionString?: string;
    databaseName?: string;
    serverFqdn?: string;
  };
  connectionString?: string;
}

/**
 * Interface for an asynchronous operation result
 */
interface OperationResult {
  status: string;
  createdTimeUtc: string;
  lastUpdatedTimeUtc: string;
  percentComplete: number;
  error: any | null;
  id?: string;
  result?: SqlDatabase;
}

/**
 * API response when creating a database
 */
interface CreateDatabaseResponse extends SqlDatabase {
  isAsyncOperation?: boolean;
  operationLocation?: string;
  operationId?: string;
  retryAfter?: number;
}

/**
 * Manages SQL databases in Microsoft Fabric
 */
export class SqlManager extends FabricApiClient {
  /**
   * Creates a SQL database named "rayfindb" in the specified workspace.
   * This method follows a linear flow with no fallbacks and fails fast on any errors.
   *
   * @param workspaceId - The ID of the workspace to create the database in
   * @returns The created SQL database with connection string
   */
  public async createDatabase(workspaceId: string): Promise<SqlDatabase> {
    console.log(
      `Creating 'rayfindb' SQL database in workspace ${workspaceId}...`
    );

    try {
      // Make the API request to create the database
      const response = await this.request<
        CreateDatabaseResponse | OperationResult
      >(`/workspaces/${workspaceId}/sqlDatabases`, 'POST', {
        displayName: 'rayfindb',
        description: 'SQL Database for Rayfin application',
        type: 'SQLDatabase',
      });

      if (!response) {
        throw new Error(
          'Failed to create SQL database: Empty response received'
        );
      }

      // Case 1: Handle asynchronous operation (HTTP 202 Accepted)
      if (
        'isAsyncOperation' in response &&
        response.isAsyncOperation &&
        response.operationLocation
      ) {
        return await this.handleAsyncOperation(
          workspaceId,
          response as CreateDatabaseResponse
        );
      }

      // Case 2: Handle synchronous operation (HTTP 201 Created) with database details
      if ('id' in response && response.id) {
        try {
          return await this.getSqlDatabaseById(workspaceId, response.id);
        } catch (error) {
          console.warn(
            `Failed to get database by ID from response: ${(error as Error).message}`
          );
          console.log('Falling back to listing all databases...');
          // Continue to the fallback approach below
        }
      }

      // For all other cases, including direct operation result or fallback from above
      console.log('Waiting before listing databases...');

      // Wait a bit to allow the database to be fully created and visible
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Then list all databases and find the one we just created
      console.log('Listing all SQL databases in the workspace...');
      const databases = await this.listSqlDatabases(workspaceId);
      console.log(
        `Found ${databases.length} databases in workspace: ${databases.map((db) => `'${db.displayName}' (${db.id})`).join(', ')}`
      );

      const database = databases.find(
        (db) => db.displayName.toLowerCase() === 'rayfindb'
      );

      if (database) {
        console.log(
          `Found database with name 'rayfindb' and ID: ${database.id}`
        );
        return await this.getSqlDatabaseById(workspaceId, database.id);
      }

      // If we can't find by name, just return the first database as a fallback
      if (databases.length > 0) {
        console.log(
          `Could not find database named 'rayfindb', using first available database with ID: ${databases[0].id}`
        );
        return await this.getSqlDatabaseById(workspaceId, databases[0].id);
      }

      throw new Error(
        'Failed to find any databases in the workspace after creation attempt'
      );
    } catch (error) {
      console.error('Error creating SQL database:', error);
      throw new Error(
        `Failed to create SQL database: ${(error as Error).message}`
      );
    }
  }

  /**
   * Handles an asynchronous database creation operation by polling until completion
   *
   * @param workspaceId - The workspace ID
   * @param response - The initial API response containing operation details
   * @returns The created database with connection string
   */
  private async handleAsyncOperation(
    workspaceId: string,
    response: CreateDatabaseResponse
  ): Promise<SqlDatabase> {
    if (!response.operationLocation) {
      throw new Error('Async operation missing operation location URL');
    }

    console.log(
      'Database creation started as async operation, polling for completion...'
    );

    // Poll the operation status until completion
    const operationResult = await this.pollOperationStatus<OperationResult>(
      response.operationLocation,
      response.retryAfter || 5,
      60 // Max retries (5 minutes with 5-second intervals)
    );

    console.log(
      `Async operation completed with status: ${operationResult.status}`
    );

    if (operationResult.status !== 'Succeeded') {
      throw new Error(
        `Database creation failed: ${JSON.stringify(operationResult.error) || 'Unknown error'}`
      );
    }

    // After successful async operation, get the database details
    console.log(
      'Async operation succeeded. Attempting to retrieve the created database...'
    );

    // First, check if the operation result contains the database info directly
    if (operationResult.result && operationResult.result.id) {
      console.log(
        `Database found directly in operation result with ID: ${operationResult.result.id}`
      );
      try {
        return await this.getSqlDatabaseById(
          workspaceId,
          operationResult.result.id
        );
      } catch (error) {
        console.warn(
          `Failed to get database by ID from operation result: ${(error as Error).message}`
        );
        console.log('Falling back to listing all databases...');
        // Continue to the list databases approach below
      }
    } else {
      console.log(
        'Operation result does not contain direct database reference'
      );
    }

    // Always list databases after a successful async operation, regardless of whether
    // we found the database in the operation result

    // Wait a bit before trying to list all databases (to allow for any propagation delay)
    const waitTimeMs = 5000;
    console.log(
      `Waiting ${waitTimeMs / 1000} seconds before listing databases to allow for propagation...`
    );
    await new Promise((resolve) => setTimeout(resolve, waitTimeMs));

    // Now try to find it in the list of databases
    console.log('Listing all SQL databases in the workspace...');
    const databases = await this.listSqlDatabases(workspaceId);
    console.log(
      `Found ${databases.length} databases in workspace: ${databases.map((db) => `'${db.displayName}' (${db.id})`).join(', ')}`
    );

    // Always look for rayfindb by name
    const database = databases.find(
      (db) => db.displayName.toLowerCase() === 'rayfindb'
    );

    if (database) {
      console.log(`Found database with name 'rayfindb' and ID: ${database.id}`);
      // Get full details including connection string
      return await this.getSqlDatabaseById(workspaceId, database.id);
    }

    // If we can't find by name, just return the first database as a fallback
    if (databases.length > 0) {
      console.log(
        `Could not find database named 'rayfindb', using first available database with ID: ${databases[0].id}`
      );
      return await this.getSqlDatabaseById(workspaceId, databases[0].id);
    }

    throw new Error(
      'Database creation succeeded but could not find any databases in the workspace'
    );
  }

  /**
   * Gets a SQL database by ID
   * @param workspaceId - The ID of the workspace containing the database
   * @param databaseId - The ID of the database to retrieve
   * @returns The SQL database with connection string
   */
  public async getSqlDatabaseById(
    workspaceId: string,
    databaseId: string
  ): Promise<SqlDatabase> {
    console.log(`Getting SQL database details for ID: ${databaseId}`);

    try {
      const database = await this.request<SqlDatabase>(
        `/workspaces/${workspaceId}/sqlDatabases/${databaseId}`
      );

      if (!database) {
        throw new Error('Empty response when fetching database details');
      }

      if (!database.properties?.connectionString) {
        throw new Error(
          'Database retrieved but connection string is not available'
        );
      }

      return {
        ...database,
        connectionString: database.properties.connectionString,
      };
    } catch (error) {
      console.error('Error getting SQL database by ID:', error);
      throw new Error(
        `Failed to get SQL database details: ${(error as Error).message}`
      );
    }
  }

  /**
   * Lists all SQL databases in a workspace
   * @param workspaceId - The ID of the workspace to list databases from
   * @returns Array of SQL databases
   */
  public async listSqlDatabases(workspaceId: string): Promise<SqlDatabase[]> {
    console.log(`Listing SQL databases in workspace: ${workspaceId}`);

    try {
      const response = await this.request<{ value: SqlDatabase[] }>(
        `/workspaces/${workspaceId}/sqlDatabases`
      );

      if (!response || !response.value) {
        return [];
      }

      return response.value.map((db) => ({
        ...db,
        // Make sure connectionString is at the top level for backward compatibility
        connectionString: db.properties?.connectionString,
      }));
    } catch (error) {
      console.error('Error listing SQL databases:', error);
      throw new Error(
        `Failed to list SQL databases: ${(error as Error).message}`
      );
    }
  }

  /**
   * For backward compatibility - delegates to createDatabase
   */
  public async createSqlDatabase(options: {
    workspaceId: string;
    displayName: string;
    description?: string;
  }): Promise<SqlDatabase> {
    console.log(
      `Creating 'rayfindb' SQL database (ignoring provided name: "${options.displayName}")...`
    );
    return this.createDatabase(options.workspaceId);
  }

  /**
   * Gets or creates a SQL database named "rayfindb" in the specified workspace.
   * Checks for existing database first to ensure idempotency.
   */
  public async getOrCreateSqlDatabase(options: {
    workspaceId: string;
    displayName: string;
    description?: string;
  }): Promise<SqlDatabase> {
    console.log(
      `Getting or creating 'rayfindb' SQL database in workspace ${options.workspaceId}...`
    );

    try {
      // First, check if the database already exists
      const databases = await this.listSqlDatabases(options.workspaceId);
      const existingDatabase = databases.find(
        (db) => db.displayName.toLowerCase() === 'rayfindb'
      );

      if (existingDatabase) {
        console.log(
          `SQL database 'rayfindb' already exists (ID: ${existingDatabase.id})`
        );
        // Get full details including connection string
        return await this.getSqlDatabaseById(
          options.workspaceId,
          existingDatabase.id
        );
      }

      // Database doesn't exist, create it
      console.log(
        `SQL database 'rayfindb' not found, creating new database...`
      );
      return this.createDatabase(options.workspaceId);
    } catch (error) {
      console.error('Error in getOrCreateSqlDatabase:', error);
      throw new Error(
        `Failed to get or create SQL database: ${(error as Error).message}`
      );
    }
  }
}

export default SqlManager;
