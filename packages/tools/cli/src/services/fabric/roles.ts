import FabricApiClient from './client.js';

export interface RoleAssignment {
  id: string;
  properties: {
    principalId: string;
    roleDefinitionId: string;
    scope: string;
    principalType: string;
  };
  [key: string]: any;
}

export interface RoleDefinition {
  id: string;
  displayName: string;
  description: string;
  [key: string]: any;
}

/**
 * Manages role assignments in Microsoft Fabric
 */
export class RoleManager extends FabricApiClient {
  /**
   * Lists all role definitions available in Fabric
   */
  public async listRoleDefinitions(): Promise<RoleDefinition[]> {
    const response = await this.request<{ value: RoleDefinition[] }>(
      '/roleDefinitions'
    );
    return response.value;
  }

  /**
   * Gets a role definition by name (e.g., "Contributor")
   */
  public async getRoleDefinitionByName(
    roleName: string
  ): Promise<RoleDefinition | undefined> {
    const roles = await this.listRoleDefinitions();
    return roles.find(
      (r) => r.displayName.toLowerCase() === roleName.toLowerCase()
    );
  }

  /**
   * Assigns a role to a principal (user, group, or service principal) in a workspace
   *
   * Uses the official Microsoft Fabric API endpoint:
   * `POST https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/roleAssignments`
   */
  public async assignRoleToWorkspace(options: {
    principalId: string;
    workspaceId: string;
    roleName: string;
    principalType?: string;
  }): Promise<RoleAssignment> {
    // Skip the role definition lookup since the endpoint is not working
    // and just use the role name directly in the request

    // Create the role assignment using the proper payload format with principal and role fields
    // according to https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/add-workspace-role-assignment?tabs=HTTP
    return this.request<RoleAssignment>(
      `/workspaces/${options.workspaceId}/roleAssignments`,
      'POST',
      {
        principal: {
          id: options.principalId,
          type: options.principalType || 'ServicePrincipal',
        },
        role: options.roleName,
      }
    );
  }

  /**
   * Checks if a principal already has a role in a workspace
   */
  public async checkRoleAssignment(options: {
    principalId: string;
    workspaceId: string;
    roleName?: string;
  }): Promise<boolean> {
    try {
      // List all role assignments for the workspace
      const response = await this.request<{ value: RoleAssignment[] }>(
        `/workspaces/${options.workspaceId}/roleAssignments`
      );

      // Find assignments for the specified principal
      const assignments = response.value.filter(
        (ra) =>
          ra.properties && ra.properties.principalId === options.principalId
      );

      if (options.roleName) {
        // If role name is specified, check if that specific role is assigned
        const roleDefinition = await this.getRoleDefinitionByName(
          options.roleName
        );
        if (!roleDefinition) {
          return false;
        }

        return assignments.some(
          (ra) => ra.properties.roleDefinitionId === roleDefinition.id
        );
      }

      // If no specific role is requested, return true if any role is assigned
      return assignments.length > 0;
    } catch (error) {
      console.error(
        `Error checking role assignment: ${(error as Error).message}`
      );
      return false;
    }
  }
}

export default RoleManager;
