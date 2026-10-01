import FabricApiClient from './client.js';

export interface FabricWorkspace {
  id: string;
  displayName: string;
  description: string;
  capacityId?: string;
  state?: string;
  type?: string;
  [key: string]: any;
}

/**
 * Manages Microsoft Fabric workspace operations
 */
export class WorkspaceManager extends FabricApiClient {
  /**
   * Lists all workspaces the authenticated user has access to.
   *
   * Follows Fabric API pagination (`continuationToken`) so callers receive
   * the full set of workspaces, not just the first page (~100 items).
   * See https://learn.microsoft.com/en-us/rest/api/fabric/articles/pagination
   */
  public async listWorkspaces(): Promise<FabricWorkspace[]> {
    return this.listAllPages<FabricWorkspace>('/workspaces');
  }

  /**
   * Gets details of a specific workspace
   */
  public async getWorkspace(workspaceId: string): Promise<FabricWorkspace> {
    return this.request<FabricWorkspace>(`/workspaces/${workspaceId}`);
  }
}

export default WorkspaceManager;
