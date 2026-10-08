/**
 * Edge cases for `connectorConfig.entities` accepting either a decorated
 * entity class or an explicit column list.
 *
 * The column-list form exists because a decorated class cannot be referenced
 * from browser code — bundlers lower the decorators into an invalid class
 * expression and the app fails to parse. These tests pin the semantics of the
 * two forms against each other so the browser-safe form cannot silently
 * diverge from the class form.
 */
import type { ApiClient } from '@microsoft/rayfin-lib';
import { describe, expect, it, vi } from 'vitest';

import { createConnectorsApi } from '../Connectors';
import type { ConnectorConfig } from '../ConnectorsSchema';
import { entityReturnColumns, resolveReturnColumns } from '../utils';

import { Product, Renamed } from './fixtures/entities';

/** The return selection set of a built mutation — the block after the last `) {`. */
function returnSelection(query: string): string {
  return query.slice(query.lastIndexOf(') {') + 3);
}

function capturingClient(response: unknown) {
  const post = vi.fn(async () => response);
  return { post, apiClient: { post } as unknown as ApiClient };
}

function lastQuery(post: ReturnType<typeof vi.fn>): string {
  const calls = post.mock.calls as unknown as unknown[][];
  return (calls[calls.length - 1]![1] as { query: string }).query;
}

describe('resolveReturnColumns', () => {
  it('derives GraphQL field names from a decorated class', () => {
    expect(resolveReturnColumns(Product)).toEqual(entityReturnColumns(Product));
  });

  // The single most likely authoring mistake: copying DB column names out of
  // metadata.json instead of the entity's property names.
  it('uses property names, not DB column names, for the class form', () => {
    const columns = resolveReturnColumns(Product);
    expect(columns).toContain('productId');
    expect(columns).not.toContain('ProductID');
  });

  it('uses the property name, not the DB column, for the GraphQL field', () => {
    const columns = resolveReturnColumns(Renamed);
    expect(columns).toContain('email');
    expect(columns).not.toContain('email_address');
  });

  it('passes an explicit column list through unchanged', () => {
    expect(resolveReturnColumns(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns an empty list for undefined', () => {
    expect(resolveReturnColumns(undefined)).toEqual([]);
  });

  it('returns an empty list for an empty array', () => {
    expect(resolveReturnColumns([])).toEqual([]);
  });

  it('does not mistake a class for an array', () => {
    expect(Array.isArray(Product)).toBe(false);
    expect(resolveReturnColumns(Product).length).toBeGreaterThan(0);
  });
});

describe('entities map — no-selection read forms', () => {
  const columns = ['productId', 'name', 'price'];

  it.each([
    ['findMany', (e: any) => e.findMany()],
    ['findFirst', (e: any) => e.findFirst()],
  ])('%s uses the column list when no selection is given', async (_n, call) => {
    const { post, apiClient } = capturingClient({
      data: { products: { items: [] } },
    });
    const api = createConnectorsApi(apiClient, {
      db: { connector: 'fabric-sqldatabase', entities: { Product } },
    });

    await call((api as unknown as Record<string, any>).db.Product);

    const query = lastQuery(post);
    for (const column of columns) expect(query).toContain(column);
  });

  it('findByKey uses the column list when no selection is given', async () => {
    const { post, apiClient } = capturingClient({
      data: { product_by_pk: null },
    });
    const api = createConnectorsApi(apiClient, {
      db: { connector: 'fabric-sqldatabase', entities: { Product } },
    });

    await (api as unknown as Record<string, any>).db.Product.findByKey({
      productId: '1',
    });

    const query = lastQuery(post);
    for (const column of columns) expect(query).toContain(column);
  });

  it('an explicit selection still overrides the column list', async () => {
    const { post, apiClient } = capturingClient({
      data: { products: { items: [] } },
    });
    const api = createConnectorsApi(apiClient, {
      db: { connector: 'fabric-sqldatabase', entities: { Product } },
    });

    await (api as unknown as Record<string, any>).db.Product.findMany(['name']);

    const query = lastQuery(post);
    expect(query).toContain('name');
    expect(query).not.toContain('price');
  });
});

describe('entities map — partial and degenerate configurations', () => {
  it('gates only the entities missing from the map', async () => {
    const { apiClient } = capturingClient({
      data: { products: { items: [] } },
    });
    const api = createConnectorsApi(apiClient, {
      db: {
        connector: 'fabric-sqldatabase',
        entities: { Product },
      },
    });

    // Mapped entity reads fine.
    await expect(
      (api as unknown as Record<string, any>).db.Product.findMany()
    ).resolves.toBeDefined();

    // An entity absent from the map has no default selection.
    await expect(
      (api as unknown as Record<string, any>).db.Missing.findMany()
    ).rejects.toThrow(/SELECTION_REQUIRED|requires an explicit/);
  });

  it('supports multiple entity classes in the same map', async () => {
    // Two different entities are queried, so the stub has to answer whichever
    // root field the built document actually asks for.
    const post = vi.fn(async (_url: string, body: { query: string }) => {
      const rootField = body.query.match(/\{\s*(\w+)\s*[({]/)?.[1] ?? 'items';
      return { data: { [rootField]: { items: [] } } };
    });
    const apiClient = { post } as unknown as ApiClient;

    const api = createConnectorsApi(apiClient, {
      db: {
        connector: 'fabric-sqldatabase',
        entities: { Product, Renamed },
      },
    });

    await (api as unknown as Record<string, any>).db.Product.findMany();
    expect(lastQuery(post as ReturnType<typeof vi.fn>)).toContain('productId');

    await (api as unknown as Record<string, any>).db.Renamed.findMany();
    expect(lastQuery(post as ReturnType<typeof vi.fn>)).toContain('email');
  });
});

describe('entities map — relationship selects', () => {
  it('scalar selects still work', async () => {
    const { post, apiClient } = capturingClient({
      data: { products: { items: [] } },
    });
    const api = createConnectorsApi(apiClient, {
      db: {
        connector: 'fabric-sqldatabase',
        entities: { Product },
      },
    });

    await (api as unknown as Record<string, any>).db.Product.select([
      'name',
    ]).execute();

    expect(lastQuery(post)).toContain('name');
  });
});

describe('entities map — dialects that do not read back the row', () => {
  it('warehouse mutations still select `result`, not the column list', async () => {
    const { post, apiClient } = capturingClient({
      data: { updateProduct: { result: 'success' } },
    });
    const api = createConnectorsApi(apiClient, {
      dw: {
        connector: 'fabric-warehouse',
        entities: { Product },
      },
    });

    await (api as unknown as Record<string, any>).dw.Product.update(
      { productId: '1' },
      { name: 'Widget' }
    );

    const selection = returnSelection(lastQuery(post));
    expect(selection).toContain('result');
    expect(selection).not.toContain('productId');
  });

  it('warehouse reads still use the column list', async () => {
    const { post, apiClient } = capturingClient({
      data: { products: { items: [] } },
    });
    const api = createConnectorsApi(apiClient, {
      dw: {
        connector: 'fabric-warehouse',
        entities: { Product },
      },
    });

    await (api as unknown as Record<string, any>).dw.Product.findMany();
    expect(lastQuery(post)).toContain('productId');
  });
});

describe('entities map — declared shape', () => {
  it('accepts the `as const satisfies ConnectorConfig` form the guide documents', () => {
    const connectorConfig = {
      connector: 'fabric-sqldatabase',
      entities: { Product },
    } as const satisfies ConnectorConfig;

    expect(connectorConfig.entities.Product).toBe(Product);
  });
});
