/**
 * Workspace endpoints of the Fabric REST API.
 *
 * Callers pass resource ids rather than paths so URL construction and encoding
 * remain consistent across every host.
 */
import type { FabricWorkspace } from './client.js';
import type { FabricHttpClient } from './http-client.js';
import { collectPages, findInPages } from './pagination.js';
import type { FabricAcceptedResponse } from './types.js';

export class WorkspaceManager {
  public constructor(
    private readonly transport: FabricHttpClient,
    private readonly baseUrl: string
  ) {}

  public list(): Promise<FabricWorkspace[]> {
    return collectPages<FabricWorkspace>(
      this.transport,
      this.baseUrl,
      '/workspaces'
    );
  }

  public async isAdmin(workspaceId: string): Promise<boolean> {
    const match = await findInPages<FabricWorkspace>(
      this.transport,
      this.baseUrl,
      '/workspaces?roles=Admin',
      (workspace) => workspace.id === workspaceId
    );
    return match !== undefined;
  }

  public get(workspaceId: string): Promise<FabricWorkspace> {
    return this.transport.request(this.workspacePath(workspaceId));
  }

  public create(displayName: string): Promise<FabricWorkspace> {
    return this.transport.request('/workspaces', 'POST', { displayName });
  }

  public assignToCapacity(
    workspaceId: string,
    capacityId: string
  ): Promise<FabricAcceptedResponse> {
    return this.transport.requestAccepted(
      `${this.workspacePath(workspaceId)}/assignToCapacity`,
      'POST',
      { capacityId }
    );
  }

  private workspacePath(workspaceId: string): string {
    return `/workspaces/${encodeURIComponent(workspaceId)}`;
  }
}
