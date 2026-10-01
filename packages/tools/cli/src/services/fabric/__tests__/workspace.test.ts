import { describe, expect, it } from 'vitest';

import { type FabricWorkspace, WorkspaceManager } from '../workspace.js';

type WorkspacePage = {
  value: FabricWorkspace[];
  continuationToken?: string | null;
  continuationUri?: string | null;
};

class TestWorkspaceManager extends WorkspaceManager {
  public readonly requestedPaths: string[] = [];
  private readonly pages: WorkspacePage[];

  public constructor(pages: WorkspacePage[], apiBaseUrl?: string) {
    super('test-token');
    if (apiBaseUrl) {
      this.apiBaseUrl = apiBaseUrl;
    }
    this.pages = [...pages];
  }

  protected override async request<ResponseType>(
    path: string,
    _method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
    _body?: unknown
  ): Promise<ResponseType> {
    this.requestedPaths.push(path);
    const nextPage = this.pages.shift();
    if (!nextPage) {
      throw new Error(`Unexpected request path: ${path}`);
    }
    return nextPage as ResponseType;
  }
}

describe('WorkspaceManager', () => {
  it('returns workspaces from every paginated response', async () => {
    const manager = new TestWorkspaceManager([
      {
        value: [{ id: 'workspace-1', displayName: 'First', description: '' }],
        continuationUri:
          'https://api.fabric.microsoft.com/v1/workspaces?continuationToken=LDEsMTAwMDAwLDA%3D',
        continuationToken: 'LDEsMTAwMDAwLDA%3D',
      },
      {
        value: [{ id: 'workspace-2', displayName: 'Second', description: '' }],
      },
    ]);

    const workspaces = await manager.listWorkspaces();

    expect(workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expect(manager.requestedPaths).toEqual([
      '/workspaces',
      '/workspaces?continuationToken=LDEsMTAwMDAwLDA%3D',
    ]);
  });

  it('does not double-encode continuationToken when continuationUri is absent', async () => {
    const manager = new TestWorkspaceManager([
      {
        value: [{ id: 'workspace-1', displayName: 'First', description: '' }],
        continuationToken: 'LDEsMTAwMDAwLDA%3D',
      },
      { value: [] },
    ]);

    await manager.listWorkspaces();

    expect(manager.requestedPaths).toEqual([
      '/workspaces',
      '/workspaces?continuationToken=LDEsMTAwMDAwLDA%3D',
    ]);
  });

  it('falls back to the continuation token when continuationUri targets a different origin or base path (proxy)', async () => {
    const manager = new TestWorkspaceManager(
      [
        {
          value: [{ id: 'workspace-1', displayName: 'First', description: '' }],
          // Fabric returns a URI rooted at its own service path, but the
          // configured `apiBaseUrl` is a proxy with a different path prefix.
          // Honoring the URI verbatim would produce `/proxy/v1/v1/...` or
          // drop the `/proxy` prefix entirely.
          continuationUri:
            'https://api.fabric.microsoft.com/v1/workspaces?continuationToken=LDEsMTAwMDAwLDA%3D',
          continuationToken: 'LDEsMTAwMDAwLDA%3D',
        },
        { value: [] },
      ],
      'https://my-proxy.example.com/proxy/v1'
    );

    await manager.listWorkspaces();

    expect(manager.requestedPaths).toEqual([
      '/workspaces',
      '/workspaces?continuationToken=LDEsMTAwMDAwLDA%3D',
    ]);
  });

  it('extracts the continuation token from continuationUri when no token field is provided and the URI does not match the base', async () => {
    const manager = new TestWorkspaceManager(
      [
        {
          value: [{ id: 'workspace-1', displayName: 'First', description: '' }],
          continuationUri:
            'https://api.fabric.microsoft.com/v1/workspaces?continuationToken=LDEsMTAwMDAwLDA%3D',
        },
        { value: [] },
      ],
      'https://my-proxy.example.com/proxy/v1'
    );

    await manager.listWorkspaces();

    expect(manager.requestedPaths).toEqual([
      '/workspaces',
      '/workspaces?continuationToken=LDEsMTAwMDAwLDA%3D',
    ]);
  });
});
