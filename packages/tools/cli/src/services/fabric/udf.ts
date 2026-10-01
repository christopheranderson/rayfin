import FabricApiClient from './client.js';

export interface UserDataFunction {
  id: string;
  displayName: string;
  description?: string;
  itemType: 'UserDataFunction';
  code?: string;
  language?: string;
  [key: string]: any;
}

/**
 * Manages User-Defined Functions in Microsoft Fabric
 */
export class UdfManager extends FabricApiClient {
  /**
   * Creates a new User-Defined Function in a Fabric workspace
   */
  public async createUdf(options: {
    workspaceId: string;
    displayName: string;
    description?: string;
    code: string;
    language: 'sql' | 'python' | 'r';
  }): Promise<UserDataFunction> {
    return this.request<UserDataFunction>(
      `/workspaces/${options.workspaceId}/items`,
      'POST',
      {
        displayName: options.displayName,
        description: options.description || `UDF for ${options.displayName}`,
        itemType: 'UserDataFunction',
        type: 'UserDataFunction', // Adding the required 'Type' field
        code: options.code,
        language: options.language,
      }
    );
  }

  /**
   * Lists all User-Defined Functions in a workspace
   */
  public async listUdfs(workspaceId: string): Promise<UserDataFunction[]> {
    const response = await this.request<{ value: any[] }>(
      `/workspaces/${workspaceId}/items?$filter=itemType eq 'UserDataFunction'`
    );

    return response.value as UserDataFunction[];
  }

  /**
   * Gets a User-Defined Function by name
   */
  public async getUdfByName(options: {
    workspaceId: string;
    displayName: string;
  }): Promise<UserDataFunction | undefined> {
    const udfs = await this.listUdfs(options.workspaceId);
    return udfs.find(
      (udf) =>
        udf.displayName.toLowerCase() === options.displayName.toLowerCase()
    );
  }

  /**
   * Gets or creates a User-Defined Function
   */
  public async getOrCreateUdf(options: {
    workspaceId: string;
    displayName: string;
    description?: string;
    code: string;
    language: 'sql' | 'python' | 'r';
  }): Promise<UserDataFunction> {
    // Check if UDF already exists
    const existingUdf = await this.getUdfByName({
      workspaceId: options.workspaceId,
      displayName: options.displayName,
    });

    if (existingUdf) {
      console.log(
        `UDF "${options.displayName}" already exists (ID: ${existingUdf.id})`
      );
      return existingUdf;
    }

    // Create new UDF if it doesn't exist
    console.log(`Creating new UDF "${options.displayName}"...`);
    return this.createUdf(options);
  }
}

export default UdfManager;
