import { describe, expect, it } from 'vitest';

import {
  CatalogSearchDiscoveryEngine,
  type CatalogSearchClient,
  type ItemCatalogEntry,
} from '../catalog-search-engine.js';
import { FanoutDiscoveryEngine, createDiscoveryEngine } from '../engine.js';

describe('createDiscoveryEngine', () => {
  it('returns the fan-out engine by default', () => {
    const engine = createDiscoveryEngine('token');
    expect(engine).toBeInstanceOf(FanoutDiscoveryEngine);
    expect(engine.name).toBe('fanout');
  });

  it('returns the Catalog Search engine when catalogSearch is enabled', () => {
    const engine = createDiscoveryEngine('token', { catalogSearch: true });
    expect(engine).toBeInstanceOf(CatalogSearchDiscoveryEngine);
    expect(engine.name).toBe('catalog-search');
  });
});

/** Canned Catalog Search client that records the item types it was asked for. */
class FakeCatalogClient implements CatalogSearchClient {
  public requestedItemTypes: readonly string[] = [];

  public constructor(private readonly entries: ItemCatalogEntry[]) {}

  public async searchItems(
    itemTypes: readonly string[]
  ): Promise<ItemCatalogEntry[]> {
    this.requestedItemTypes = itemTypes;
    // Return entries verbatim so the engine's own type-guard, scope filter,
    // and mapping are what's exercised (the live service filters by `Type`
    // server-side; the engine's guard is a defensive backstop).
    return this.entries;
  }
}

function entry(
  type: string,
  displayName: string,
  workspaceId: string,
  workspaceName: string,
  id = `${displayName}-id`
): ItemCatalogEntry {
  return {
    id,
    type,
    catalogEntryType: 'FabricItem',
    displayName,
    hierarchy: { workspace: { id: workspaceId, displayName: workspaceName } },
  };
}

const CATALOG_ENTRIES: ItemCatalogEntry[] = [
  entry('Warehouse', 'Contoso DW', 'ws-1', 'Sales'),
  entry('SQLDatabase', 'Orders DB', 'ws-2', 'Ops'),
  entry('Lakehouse', 'Bronze LH', 'ws-1', 'Sales'),
  entry('SemanticModel', 'Revenue Model', 'ws-3', 'Finance'),
  entry('KQLDatabase', 'Telemetry KQL', 'ws-4', 'Observability'),
];

describe('CatalogSearchDiscoveryEngine', () => {
  it('maps catalog entries to connector types with capabilities and workspace names', async () => {
    const client = new FakeCatalogClient(CATALOG_ENTRIES);
    const engine = new CatalogSearchDiscoveryEngine(client);

    const sources = await engine.discover({
      request: { query: '', scope: { allWorkspaces: true } },
    });

    const warehouse = sources.find((s) => s.itemType === 'Warehouse');
    expect(warehouse).toMatchObject({
      connectorType: 'fabric-warehouse',
      workspaceId: 'ws-1',
      workspaceName: 'Sales',
      itemId: 'Contoso DW-id',
      displayName: 'Contoso DW',
    });
    expect(
      Object.fromEntries(
        sources.map((source) => [
          source.connectorType,
          source.capabilities.defaultAuth,
        ])
      )
    ).toEqual({
      'fabric-warehouse': 'application',
      'fabric-sqldatabase': 'application',
      'fabric-sqlanalytics': 'application',
      'fabric-semanticmodel': 'delegated',
      kusto: 'delegated',
    });
    expect(warehouse?.capabilities.operations).toContain('read');
    // Catalog Search cannot determine workspace role (only fan-out does).
    expect(warehouse?.workspaceRole).toBeUndefined();

    // `CONNECTOR_CATALOG` maps `fabric-sqlanalytics` to the `Lakehouse`
    // item type only — `SQLEndpoint` is not a discoverable item type.
    const sqlAnalytics = sources.filter(
      (s) => s.connectorType === 'fabric-sqlanalytics'
    );
    expect(sqlAnalytics.map((s) => s.itemType).sort()).toEqual(['Lakehouse']);
  });

  it('requests the union of discoverable item types across all connectors', async () => {
    const client = new FakeCatalogClient(CATALOG_ENTRIES);
    await new CatalogSearchDiscoveryEngine(client).discover({
      request: { query: '', scope: { allWorkspaces: true } },
    });

    expect([...client.requestedItemTypes].sort()).toEqual([
      'KQLDatabase',
      'Lakehouse',
      'SQLDatabase',
      'SemanticModel',
      'Warehouse',
    ]);
  });

  it('narrows to the requested connector types', async () => {
    const client = new FakeCatalogClient(CATALOG_ENTRIES);
    const sources = await new CatalogSearchDiscoveryEngine(client).discover({
      request: { query: '', scope: { allWorkspaces: true } },
      types: ['fabric-warehouse'],
    });

    expect(client.requestedItemTypes).toEqual(['Warehouse']);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.connectorType).toBe('fabric-warehouse');
  });

  it('returns KQL databases for --type kusto', async () => {
    const client = new FakeCatalogClient(CATALOG_ENTRIES);
    const sources = await new CatalogSearchDiscoveryEngine(client).discover({
      request: { query: '', scope: { allWorkspaces: true } },
      types: ['kusto'],
    });

    expect(client.requestedItemTypes).toEqual(['KQLDatabase']);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      connectorType: 'kusto',
      itemType: 'KQLDatabase',
      workspaceId: 'ws-4',
      displayName: 'Telemetry KQL',
    });
  });

  it('filters to an explicit workspace set client-side', async () => {
    const client = new FakeCatalogClient(CATALOG_ENTRIES);
    const sources = await new CatalogSearchDiscoveryEngine(client).discover({
      request: { query: '', scope: { workspaceIds: ['ws-1'] } },
    });

    expect(sources.every((s) => s.workspaceId === 'ws-1')).toBe(true);
    expect(sources.map((s) => s.displayName).sort()).toEqual([
      'Bronze LH',
      'Contoso DW',
    ]);
  });

  it('filters to a single workspace client-side', async () => {
    const client = new FakeCatalogClient(CATALOG_ENTRIES);
    const sources = await new CatalogSearchDiscoveryEngine(client).discover({
      request: { query: '', scope: { workspaceId: 'ws-2' } },
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]!).toMatchObject({
      connectorType: 'fabric-sqldatabase',
      workspaceId: 'ws-2',
    });
  });

  it('filters by case-insensitive display-name substring', async () => {
    const client = new FakeCatalogClient(CATALOG_ENTRIES);
    const sources = await new CatalogSearchDiscoveryEngine(client).discover({
      request: { query: 'bronze', scope: { allWorkspaces: true } },
    });

    expect(sources.map((s) => s.displayName)).toEqual(['Bronze LH']);
  });

  it('returns results in stable connector/workspace/name order', async () => {
    const client = new FakeCatalogClient(CATALOG_ENTRIES);
    const sources = await new CatalogSearchDiscoveryEngine(client).discover({
      request: { query: '', scope: { allWorkspaces: true } },
    });

    const ordered = [...sources].sort(
      (a, b) =>
        a.connectorType.localeCompare(b.connectorType) ||
        (a.workspaceName ?? '').localeCompare(b.workspaceName ?? '') ||
        a.displayName.localeCompare(b.displayName)
    );
    expect(sources).toEqual(ordered);
  });

  it('skips entries whose item type is not a discoverable connector type', async () => {
    const client = new FakeCatalogClient([
      entry('Notebook', 'Analysis', 'ws-1', 'Sales'),
      entry('Warehouse', 'Contoso DW', 'ws-1', 'Sales'),
    ]);
    const sources = await new CatalogSearchDiscoveryEngine(client).discover({
      request: { query: '', scope: { allWorkspaces: true } },
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]!.itemType).toBe('Warehouse');
  });
});
