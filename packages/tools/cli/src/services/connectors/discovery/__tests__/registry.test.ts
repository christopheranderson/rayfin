import type {
  ConnectorDiscoveryProvider,
  DiscoveredSource,
  DiscoveryRequest,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, expect, it } from 'vitest';

import { FabricDiscoveryClient } from '../fabric-discovery-client.js';
import { FabricConnectorProvider } from '../fabric-provider.js';
import { createFabricProviders, runProviders } from '../registry.js';

/**
 * Test double that intercepts the low-level Fabric `request` so the whole
 * client/provider stack runs against canned responses (mirrors the pattern
 * in services/fabric/__tests__/workspace.test.ts).
 */
class TestClient extends FabricDiscoveryClient {
  public readonly requestedPaths: string[] = [];

  public constructor(private readonly responder: (path: string) => unknown) {
    super('test-token');
  }

  protected override async request<ResponseType>(
    path: string
  ): Promise<ResponseType> {
    this.requestedPaths.push(path);
    return this.responder(path) as ResponseType;
  }
}

function itemsPage(
  items: Array<{ id: string; displayName: string; type: string }>
) {
  return { value: items };
}

describe('FabricDiscoveryClient', () => {
  it('memoizes workspace enumeration across repeated scope resolution', async () => {
    const client = new TestClient((path) => {
      if (path === '/workspaces') {
        return {
          value: [{ id: 'ws-1', displayName: 'Sales', description: '' }],
        };
      }
      return { value: [] };
    });

    await client.resolveWorkspaces({ allWorkspaces: true });
    await client.resolveWorkspaces({ allWorkspaces: true });

    expect(
      client.requestedPaths.filter((p) => p === '/workspaces')
    ).toHaveLength(1);
  });

  it('rejects tenant-wide scope (modeled but unimplemented)', async () => {
    const client = new TestClient(() => ({ value: [] }));
    await expect(
      client.resolveWorkspaces({ tenantWide: true })
    ).rejects.toThrow(/not implemented/i);
  });

  it('lists items with the server-side type filter', async () => {
    const client = new TestClient(() =>
      itemsPage([{ id: 'i-1', displayName: 'Contoso', type: 'Warehouse' }])
    );

    const items = await client.listItemsOfType('ws-1', 'Warehouse');

    expect(items.map((i) => i.id)).toEqual(['i-1']);
    expect(client.requestedPaths).toEqual([
      '/workspaces/ws-1/items?type=Warehouse',
    ]);
  });

  it('falls back to a workspace stub when the workspace GET is forbidden', async () => {
    const client = new TestClient((path) => {
      if (path.startsWith('/workspaces/ws-x')) {
        throw new Error('403 Forbidden');
      }
      return { value: [] };
    });

    const workspaces = await client.resolveWorkspaces({ workspaceId: 'ws-x' });
    expect(workspaces).toEqual([
      { id: 'ws-x', displayName: 'ws-x', description: '' },
    ]);
  });

  it('resolves an explicit workspace set without enumerating all workspaces', async () => {
    const names: Record<string, string> = {
      '/workspaces/ws-a': 'Alpha',
      '/workspaces/ws-b': 'Beta',
    };
    const client = new TestClient((path) => {
      if (path in names) {
        return {
          id: path.split('/').pop(),
          displayName: names[path],
          description: '',
        };
      }
      return { value: [] };
    });

    const workspaces = await client.resolveWorkspaces({
      workspaceIds: ['ws-a', 'ws-b'],
    });

    expect(workspaces.map((w) => w.displayName).sort()).toEqual([
      'Alpha',
      'Beta',
    ]);
    // Never falls back to the global /workspaces enumeration for an explicit set.
    expect(client.requestedPaths).not.toContain('/workspaces');
  });
  describe('getMyRoleInWorkspace', () => {
    it('returns Unknown when no userOid is provided', async () => {
      const client = new TestClient(() => ({ value: [] }));
      const role = await client.getMyRoleInWorkspace('ws-1');
      expect(role).toBe('Unknown');
    });

    it('returns the role when user is found in role assignments', async () => {
      const client = new TestClient((path) => {
        if (path === '/workspaces/ws-1/roleAssignments') {
          return {
            value: [
              { principal: { id: 'user-123' }, role: 'Contributor' },
              { principal: { id: 'user-456' }, role: 'Viewer' },
            ],
          };
        }
        return { value: [] };
      });

      const role = await client.getMyRoleInWorkspace('ws-1', 'user-123');
      expect(role).toBe('Contributor');
    });

    it('returns Unknown when user is not in direct role assignments', async () => {
      const client = new TestClient((path) => {
        if (path === '/workspaces/ws-1/roleAssignments') {
          return {
            value: [{ principal: { id: 'other-user' }, role: 'Admin' }],
          };
        }
        return { value: [] };
      });

      const role = await client.getMyRoleInWorkspace('ws-1', 'user-123');
      expect(role).toBe('Unknown');
    });

    it('returns Viewer when role assignments request returns 403', async () => {
      const client = new TestClient((path) => {
        if (path === '/workspaces/ws-1/roleAssignments') {
          throw new Error('403 Forbidden');
        }
        return { value: [] };
      });

      const role = await client.getMyRoleInWorkspace('ws-1', 'user-123');
      expect(role).toBe('Viewer');
    });

    it('matches userOid case-insensitively', async () => {
      const client = new TestClient((path) => {
        if (path === '/workspaces/ws-1/roleAssignments') {
          return {
            value: [{ principal: { id: 'USER-ABC' }, role: 'Admin' }],
          };
        }
        return { value: [] };
      });

      const role = await client.getMyRoleInWorkspace('ws-1', 'user-abc');
      expect(role).toBe('Admin');
    });
  });
});

describe('FabricConnectorProvider', () => {
  function warehouseClient(): FabricDiscoveryClient {
    return new TestClient((path) => {
      if (path === '/workspaces/ws-1') {
        return { id: 'ws-1', displayName: 'Sales WS', description: '' };
      }
      if (path.includes('type=Warehouse')) {
        return itemsPage([
          { id: 'w-1', displayName: 'Contoso Warehouse', type: 'Warehouse' },
          { id: 'w-2', displayName: 'Fabrikam DW', type: 'Warehouse' },
        ]);
      }
      return { value: [] };
    });
  }

  it('tags results with connector type, capabilities, and workspace name', async () => {
    const provider = new FabricConnectorProvider(
      'fabric-warehouse',
      ['Warehouse'],
      warehouseClient()
    );

    const sources = await provider.discover({
      query: '',
      scope: { workspaceId: 'ws-1' },
    });

    expect(sources).toHaveLength(2);
    const [first] = sources;
    expect(first.connectorType).toBe('fabric-warehouse');
    expect(first.workspaceName).toBe('Sales WS');
    expect(first.itemType).toBe('Warehouse');
    expect(first.capabilities.defaultAuth).toBe('application');
    expect(first.capabilities.operations).toContain('read');
  });

  it('filters by case-insensitive display-name substring', async () => {
    const provider = new FabricConnectorProvider(
      'fabric-warehouse',
      ['Warehouse'],
      warehouseClient()
    );

    const sources = await provider.discover({
      query: 'contoso',
      scope: { workspaceId: 'ws-1' },
    });

    expect(sources.map((s) => s.displayName)).toEqual(['Contoso Warehouse']);
  });
  it('enriches sources with workspace role and eligibility', async () => {
    const client = new TestClient((path) => {
      if (path === '/workspaces/ws-1') {
        return { id: 'ws-1', displayName: 'Sales WS', description: '' };
      }
      if (path === '/workspaces/ws-1/roleAssignments') {
        return {
          value: [{ principal: { id: 'user-123' }, role: 'Contributor' }],
        };
      }
      if (path.includes('type=Warehouse')) {
        return itemsPage([
          { id: 'w-1', displayName: 'Contoso Warehouse', type: 'Warehouse' },
        ]);
      }
      return { value: [] };
    });

    const provider = new FabricConnectorProvider(
      'fabric-warehouse',
      ['Warehouse'],
      client,
      'user-123'
    );

    const sources = await provider.discover({
      query: '',
      scope: { workspaceId: 'ws-1' },
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      workspaceRole: 'Contributor',
      addEligible: true,
    });
    expect(sources[0].addEligibilityReason).toBeUndefined();
  });

  it('marks Viewer role as ineligible with reason', async () => {
    const client = new TestClient((path) => {
      if (path === '/workspaces/ws-1') {
        return { id: 'ws-1', displayName: 'Sales WS', description: '' };
      }
      if (path === '/workspaces/ws-1/roleAssignments') {
        throw new Error('403 Forbidden'); // Viewer can't list assignments
      }
      if (path.includes('type=Warehouse')) {
        return itemsPage([
          { id: 'w-1', displayName: 'Contoso Warehouse', type: 'Warehouse' },
        ]);
      }
      return { value: [] };
    });

    const provider = new FabricConnectorProvider(
      'fabric-warehouse',
      ['Warehouse'],
      client,
      'user-123'
    );

    const sources = await provider.discover({
      query: '',
      scope: { workspaceId: 'ws-1' },
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      workspaceRole: 'Viewer',
      addEligible: false,
      addEligibilityReason:
        'Viewer role is insufficient — Contributor or above required',
    });
  });
});

describe('runProviders', () => {
  function fakeProvider(
    type: DiscoveredSource['connectorType'],
    displayName: string
  ): ConnectorDiscoveryProvider {
    return {
      connectorTypes: [type],
      async discover(_request: DiscoveryRequest): Promise<DiscoveredSource[]> {
        return [
          {
            connectorType: type,
            itemType: 'Warehouse',
            workspaceId: 'ws-1',
            workspaceName: 'WS',
            itemId: `${type}-item`,
            displayName,
            capabilities: {
              operations: ['read'],
              defaultAuth: 'delegated',
              requiresVersion: false,
            },
          },
        ];
      },
    };
  }

  const request: DiscoveryRequest = {
    query: '',
    scope: { allWorkspaces: true },
  };

  it('merges results across providers with deterministic ordering', async () => {
    const providers = [
      fakeProvider('fabric-warehouse', 'B warehouse'),
      fakeProvider('fabric-sqldatabase', 'A database'),
    ];

    const merged = await runProviders(providers, request);

    // Sorted by connectorType first: sqldatabase < warehouse.
    expect(merged.map((s) => s.connectorType)).toEqual([
      'fabric-sqldatabase',
      'fabric-warehouse',
    ]);
  });

  it('narrows to the requested connector types', async () => {
    const providers = [
      fakeProvider('fabric-warehouse', 'warehouse'),
      fakeProvider('fabric-sqldatabase', 'database'),
    ];

    const merged = await runProviders(providers, request, [
      'fabric-sqldatabase',
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.connectorType).toBe('fabric-sqldatabase');
  });
});

describe('createFabricProviders', () => {
  it('registers one provider per discoverable catalog entry', () => {
    const client = new TestClient(() => ({ value: [] }));
    const providers = createFabricProviders(client);

    const covered = providers.flatMap((p) => p.connectorTypes).sort();
    expect(covered).toEqual([
      'fabric-semanticmodel',
      'fabric-sqlanalytics',
      'fabric-sqldatabase',
      'fabric-warehouse',
      'kusto',
    ]);
  });
});
