import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KustoEndpointManager } from '../services/fabric/kusto-endpoint.js';

/**
 * Build a minimal `fetch` Response stand-in that `FabricApiClient.request`
 * understands: a 200 OK carrying `body` as JSON. We only exercise happy-path
 * HTTP here; resolution error branches are driven by missing fields in the
 * body, not HTTP errors.
 */
function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { forEach: () => {}, get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** Silent output so error-path tests don't spam the console. */
const silent = { log: () => {}, warn: () => {}, error: () => {} };

const WS = 'ws-1';

describe('KustoEndpointManager', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const newManager = () => new KustoEndpointManager('token', silent);

  describe('Eventhouse', () => {
    it('resolves the single child KQL database for an exact name', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('/eventhouses/eh-1')) {
          return Promise.resolve(
            okJson({
              displayName: 'MyEventhouse',
              properties: {
                queryServiceUri: 'https://cluster.kusto.fabric.microsoft.com',
                databasesItemIds: ['kdb-1'],
              },
            })
          );
        }
        if (url.includes('/kqlDatabases/kdb-1')) {
          return Promise.resolve(
            okJson({
              displayName: 'RealDbName',
              properties: {
                queryServiceUri: 'https://cluster.kusto.fabric.microsoft.com',
              },
            })
          );
        }
        throw new Error(`unexpected url ${url}`);
      });

      const resolved = await newManager().resolve(WS, 'eh-1', 'Eventhouse');

      expect(resolved).toEqual({
        queryServiceUri: 'https://cluster.kusto.fabric.microsoft.com',
        databaseName: 'RealDbName',
        resolvedItemId: 'kdb-1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws when the Eventhouse hosts multiple databases (ambiguous)', async () => {
      fetchMock.mockResolvedValue(
        okJson({
          displayName: 'MultiEH',
          properties: {
            queryServiceUri: 'https://multi.kusto.fabric.microsoft.com',
            databasesItemIds: ['a', 'b'],
          },
        })
      );

      await expect(
        newManager().resolve(WS, 'eh-2', 'Eventhouse')
      ).rejects.toThrow(/hosts 2 databases/);
      // No hop to a child database — we fail on the Eventhouse itself.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws when the Eventhouse hosts no databases', async () => {
      fetchMock.mockResolvedValue(
        okJson({
          displayName: 'EmptyEH',
          properties: {
            queryServiceUri: 'https://empty.kusto.fabric.microsoft.com',
            databasesItemIds: [],
          },
        })
      );

      await expect(
        newManager().resolve(WS, 'eh-3', 'Eventhouse')
      ).rejects.toThrow(/no KQL databases/);
    });

    it('throws when the Eventhouse has no queryServiceUri', async () => {
      fetchMock.mockResolvedValue(
        okJson({ displayName: 'NoUri', properties: {} })
      );

      await expect(
        newManager().resolve(WS, 'eh-4', 'Eventhouse')
      ).rejects.toThrow(/queryServiceUri/);
    });
  });

  describe('KQLDatabase', () => {
    it('resolves directly from the KQL database item', async () => {
      fetchMock.mockResolvedValue(
        okJson({
          displayName: 'DirectDb',
          properties: {
            queryServiceUri: 'https://direct.kusto.fabric.microsoft.com',
          },
        })
      );

      const resolved = await newManager().resolve(WS, 'kdb-9', 'KQLDatabase');

      expect(resolved).toEqual({
        queryServiceUri: 'https://direct.kusto.fabric.microsoft.com',
        databaseName: 'DirectDb',
        resolvedItemId: 'kdb-9',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('hops to the parent Eventhouse when the URI is missing on the database', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('/kqlDatabases/kdb-10')) {
          return Promise.resolve(
            okJson({
              displayName: 'ChildDb',
              properties: { parentEventhouseItemId: 'eh-parent' },
            })
          );
        }
        if (url.includes('/eventhouses/eh-parent')) {
          return Promise.resolve(
            okJson({
              displayName: 'ParentEH',
              properties: {
                queryServiceUri: 'https://parent.kusto.fabric.microsoft.com',
              },
            })
          );
        }
        throw new Error(`unexpected url ${url}`);
      });

      const resolved = await newManager().resolve(WS, 'kdb-10', 'KQLDatabase');

      expect(resolved).toEqual({
        queryServiceUri: 'https://parent.kusto.fabric.microsoft.com',
        databaseName: 'ChildDb',
        resolvedItemId: 'kdb-10',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws when the database name cannot be resolved', async () => {
      fetchMock.mockResolvedValue(
        okJson({ properties: { queryServiceUri: 'x' } })
      );

      await expect(
        newManager().resolve(WS, 'kdb-11', 'KQLDatabase')
      ).rejects.toThrow(/database name/);
    });

    it('throws when neither the database nor its parent yields a URI', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('/kqlDatabases/kdb-12')) {
          return Promise.resolve(
            okJson({
              displayName: 'Orphan',
              properties: { parentEventhouseItemId: 'eh-missing' },
            })
          );
        }
        return Promise.resolve(okJson({ displayName: 'EH', properties: {} }));
      });

      await expect(
        newManager().resolve(WS, 'kdb-12', 'KQLDatabase')
      ).rejects.toThrow(/queryServiceUri/);
    });
  });

  it('throws for an unsupported item type', async () => {
    await expect(newManager().resolve(WS, 'x', 'Lakehouse')).rejects.toThrow(
      /Unsupported item type "Lakehouse"/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
