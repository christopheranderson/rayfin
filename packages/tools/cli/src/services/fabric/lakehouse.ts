import FabricApiClient from './client.js';

/**
 * Interface representing a Lakehouse in Microsoft Fabric
 */
export interface Lakehouse {
  id: string;
  displayName: string;
  description?: string;
  type: 'Lakehouse';
  workspaceId: string;
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
  result?: Lakehouse;
}

/**
 * API response when creating a lakehouse
 */
interface CreateLakehouseResponse extends Lakehouse {
  isAsyncOperation?: boolean;
  operationLocation?: string;
  operationId?: string;
  retryAfter?: number;
}

/**
 * Manages Lakehouses in Microsoft Fabric
 */
export class LakehouseManager extends FabricApiClient {
  /**
   * Creates a lakehouse in the specified workspace.
   *
   * @param workspaceId - The ID of the workspace to create the lakehouse in
   * @param displayName - The display name for the lakehouse
   * @param description - Optional description for the lakehouse
   * @returns The created lakehouse
   */
  public async createLakehouse(
    workspaceId: string,
    displayName: string,
    description?: string
  ): Promise<Lakehouse> {
    console.log(
      `Creating lakehouse '${displayName}' in workspace ${workspaceId}...`
    );

    try {
      // Make the API request to create the lakehouse
      const response = await this.request<
        CreateLakehouseResponse | OperationResult
      >(`/workspaces/${workspaceId}/lakehouses`, 'POST', {
        displayName,
        description,
      });

      if (!response) {
        throw new Error('Failed to create lakehouse: Empty response received');
      }

      // Case 1: Handle asynchronous operation (HTTP 202 Accepted)
      if (
        'isAsyncOperation' in response &&
        response.isAsyncOperation &&
        response.operationLocation
      ) {
        return await this.handleAsyncOperation(
          workspaceId,
          response as CreateLakehouseResponse
        );
      }

      // Case 2: Handle immediate creation response (HTTP 201 Created)
      if ('displayName' in response && 'id' in response) {
        const lakehouse = response as Lakehouse;
        console.log(
          `Lakehouse '${lakehouse.displayName}' created successfully with ID: ${lakehouse.id}`
        );
        return lakehouse;
      }

      // Case 3: Handle operation result (from polling)
      if ('status' in response) {
        const operationResult = response as OperationResult;
        if (operationResult.status === 'succeeded' && operationResult.result) {
          console.log(
            `Lakehouse '${operationResult.result.displayName}' created successfully with ID: ${operationResult.result.id}`
          );
          return operationResult.result;
        } else {
          throw new Error(
            `Operation failed with status: ${operationResult.status}`
          );
        }
      }

      throw new Error('Unexpected response format from lakehouse creation API');
    } catch (error) {
      console.error('Error creating lakehouse:', error);
      throw new Error(
        `Failed to create lakehouse: ${(error as Error).message}`
      );
    }
  }

  /**
   * Handles an asynchronous lakehouse creation operation by polling until completion
   *
   * @param workspaceId - The workspace ID
   * @param response - The initial response from the creation request
   * @returns The created lakehouse
   */
  private async handleAsyncOperation(
    workspaceId: string,
    response: CreateLakehouseResponse
  ): Promise<Lakehouse> {
    console.log(
      `Lakehouse creation is async operation, polling for completion...`
    );

    if (!response.operationLocation) {
      throw new Error('Async operation response missing operation location');
    }

    try {
      // Poll the operation status endpoint until completion
      const operationResult = await this.pollOperationStatus<OperationResult>(
        response.operationLocation,
        response.retryAfter || 30
      );

      // Check if the operation succeeded and has a result
      if (operationResult.status === 'succeeded' && operationResult.result) {
        console.log(
          `Lakehouse '${operationResult.result.displayName}' created successfully with ID: ${operationResult.result.id}`
        );
        return operationResult.result;
      }

      // If no result but operation succeeded, try to find the lakehouse by listing
      if (operationResult.status === 'succeeded') {
        console.log(
          'Operation succeeded but no result returned, searching for created lakehouse...'
        );
        return await this.findCreatedLakehouse(workspaceId);
      }

      throw new Error(
        `Lakehouse creation operation failed with status: ${operationResult.status}`
      );
    } catch (error) {
      console.error('Error in async lakehouse creation:', error);
      throw new Error(
        `Failed to complete lakehouse creation: ${(error as Error).message}`
      );
    }
  }

  /**
   * Attempts to find a recently created lakehouse when the operation result doesn't include it
   *
   * @param workspaceId - The workspace ID to search in
   * @returns The found lakehouse
   */
  private async findCreatedLakehouse(workspaceId: string): Promise<Lakehouse> {
    console.log(`Searching for created lakehouse in workspace...`);

    try {
      const lakehouses = await this.listLakehouses(workspaceId);

      if (lakehouses.length === 0) {
        throw new Error(
          'No lakehouses found in the workspace after creation attempt'
        );
      }

      // Return the first lakehouse found (in a typical scenario, this would be the one we just created)
      const lakehouse = lakehouses[0];
      console.log(
        `Found lakehouse '${lakehouse.displayName}' with ID: ${lakehouse.id}`
      );
      return lakehouse;
    } catch (error) {
      console.error('Error finding created lakehouse:', error);
      throw new Error(
        'Lakehouse creation succeeded but could not find any lakehouses in the workspace'
      );
    }
  }

  /**
   * Gets a lakehouse by ID
   * @param workspaceId - The ID of the workspace containing the lakehouse
   * @param lakehouseId - The ID of the lakehouse to retrieve
   * @returns The lakehouse
   */
  public async getLakehouseById(
    workspaceId: string,
    lakehouseId: string
  ): Promise<Lakehouse> {
    console.log(`Getting lakehouse details for ID: ${lakehouseId}`);
    try {
      const lakehouse = await this.request<Lakehouse>(
        `/workspaces/${workspaceId}/lakehouses/${lakehouseId}`
      );
      if (!lakehouse) {
        throw new Error('Empty response when fetching lakehouse details');
      }
      return lakehouse;
    } catch (error) {
      console.error('Error getting lakehouse by ID:', error);
      throw new Error(
        `Failed to get lakehouse details: ${(error as Error).message}`
      );
    }
  }

  /**
   * Lists all lakehouses in a workspace
   * @param workspaceId - The ID of the workspace to list lakehouses from
   * @returns Array of lakehouses
   */
  public async listLakehouses(workspaceId: string): Promise<Lakehouse[]> {
    console.log(`Listing lakehouses in workspace: ${workspaceId}`);
    try {
      const response = await this.request<{ value: Lakehouse[] }>(
        `/workspaces/${workspaceId}/lakehouses`
      );
      if (!response || !response.value) {
        return [];
      }
      return response.value;
    } catch (error) {
      console.error('Error listing lakehouses:', error);
      throw new Error(`Failed to list lakehouses: ${(error as Error).message}`);
    }
  }

  /**
   * Gets or creates a lakehouse in the specified workspace.
   * Checks for existing lakehouse first to ensure idempotency.
   */
  public async getOrCreateLakehouse(options: {
    workspaceId: string;
    displayName: string;
    description?: string;
  }): Promise<Lakehouse> {
    console.log(
      `Getting or creating lakehouse '${options.displayName}' in workspace ${options.workspaceId}...`
    );

    try {
      // First, check if a lakehouse with the same display name already exists
      const lakehouses = await this.listLakehouses(options.workspaceId);
      const existingLakehouse = lakehouses.find(
        (lh) =>
          lh.displayName.toLowerCase() === options.displayName.toLowerCase()
      );

      if (existingLakehouse) {
        console.log(
          `Lakehouse '${existingLakehouse.displayName}' already exists (ID: ${existingLakehouse.id})`
        );
        return existingLakehouse;
      }

      // Create new lakehouse if none exists
      console.log(
        `No existing lakehouse found with name '${options.displayName}', creating new one...`
      );
      return await this.createLakehouse(
        options.workspaceId,
        options.displayName,
        options.description
      );
    } catch (error) {
      console.error('Error in getOrCreateLakehouse:', error);
      throw new Error(
        `Failed to get or create lakehouse: ${(error as Error).message}`
      );
    }
  }
}

export default LakehouseManager;
