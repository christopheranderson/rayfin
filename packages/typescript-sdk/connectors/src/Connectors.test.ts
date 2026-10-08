import { entity, decimal, int, text } from '@microsoft/rayfin-core';
import type { ApiClient } from '@microsoft/rayfin-lib';
import { describe, expect, it, vi } from 'vitest';

import { ConnectorsError, createConnectorsApi } from './Connectors';
import { Source } from './category-a/schema/source';
import { supportsReadAfterWrite } from './utils';

/** The return selection set of a built mutation — the block after the last `) {`. */
function returnSelection(query: string): string {
  return query.slice(query.lastIndexOf(') {') + 3);
}

/** A connector entity with scalar columns, used to derive the full-row return selection. */
@entity()
class Product extends Source({ table: 'Product', primaryKey: ['id'] }) {
  @int({ column: 'Id' })
  id!: number;

  @text({ column: 'Name' })
  name!: string;

  @decimal({ column: 'Price', precision: 18, scale: 2 })
  price!: number;
}

describe('createConnectorsApi dispatch', () => {
  it('dispatches Cat A connectors through GraphQL endpoint', async () => {
    // Cat A clients build a GraphQL query and POST to
    // `/connectors/<name>/graphql`. We assert the URL + that
    // the body looks like a GraphQL document.
    const post = vi.fn(async () => ({ data: { products: { items: [] } } }));
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase' },
    });

    await (
      connectors as unknown as Record<string, any>
    ).salesDb.Product.findMany(['name']);

    expect(post).toHaveBeenCalledTimes(1);
    const callArgs = (post.mock.calls as unknown as unknown[][])[0];
    const url = callArgs[0] as string;
    const payload = callArgs[1] as { query: string };
    expect(url).toBe('/connectors/salesDb/graphql');
    expect(payload.query).toEqual(expect.any(String));
    expect(payload.query).toContain('products');
  });

  it('dispatches JSON-native Cat B connectors through invoke endpoint', async () => {
    const response = {
      status: 'Succeeded',
      output: {
        tables: [],
        clientRequestId: 'rayfin;query-1',
      },
      errors: [],
    };
    const post = vi.fn(async () => response);
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      telemetry: { connector: 'kusto' },
    });

    const result = await (
      connectors as unknown as Record<string, any>
    ).telemetry.executeQuery({ query: 'StormEvents | take 10' });

    expect(post).toHaveBeenCalledWith(
      '/connector-invoke/telemetry',
      {
        operation: 'executeQuery',
        input: { query: 'StormEvents | take 10' },
      },
      {
        headers: {
          Accept: 'application/vnd.apache.arrow.stream, application/json',
        },
        responseType: 'arraybuffer',
      }
    );
    expect(result).toBe(response);
  });

  it('returns the same cached client instance on repeated access', () => {
    const apiClient = { post: vi.fn() } as unknown as ApiClient;
    const connectors = createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase' },
      semanticModel: { connector: 'fabric-semanticmodel' },
    });
    const api = connectors as unknown as Record<string, any>;

    expect(api.salesDb).toBe(api.salesDb);
    expect(api.semanticModel).toBe(api.semanticModel);
    expect(api.salesDb).not.toBe(api.semanticModel);
  });

  it('throws UNKNOWN_CONNECTOR when accessing a connector with no config', () => {
    const apiClient = { post: vi.fn() } as unknown as ApiClient;
    const connectors = createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase' },
    });

    expect(
      () => (connectors as unknown as Record<string, any>).unknownConnector
    ).toThrow(ConnectorsError);
    expect(
      () => (connectors as unknown as Record<string, any>).unknownConnector
    ).toThrow(/UNKNOWN_CONNECTOR|no configuration/);
  });

  it('throws UNKNOWN_CONNECTOR when no configs were passed at all', () => {
    const apiClient = { post: vi.fn() } as unknown as ApiClient;
    // Bypass the typed contract on purpose: this test verifies the
    // defense-in-depth runtime guard for untyped JS consumers that pass
    // an empty/missing configs record despite the signature now
    // requiring an exhaustive map.
    const connectors = createConnectorsApi(apiClient, {} as any);

    expect(
      () => (connectors as unknown as Record<string, any>).anyConnector
    ).toThrow(ConnectorsError);
  });
});

describe('Cat A runtime operation gating', () => {
  it('permits methods whose CRUD verb is in the allow-list', async () => {
    const post = vi.fn(async () => ({ data: { products: { items: [] } } }));
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase', operations: ['read'] },
    });

    await expect(
      (connectors as unknown as Record<string, any>).salesDb.Product.findMany([
        'name',
      ])
    ).resolves.toEqual([]);
  });

  it('throws OPERATION_NOT_ALLOWED for methods outside the allow-list', () => {
    const apiClient = { post: vi.fn() } as unknown as ApiClient;
    const connectors = createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase', operations: ['read'] },
    });

    const product = (connectors as unknown as Record<string, any>).salesDb
      .Product;

    expect(() => product.create({ name: 'x' })).toThrow(ConnectorsError);
    expect(() => product.create({ name: 'x' })).toThrow(
      /OPERATION_NOT_ALLOWED|not in the connector's allowed operations/
    );
    expect(() => product.update({ id: '1' }, { name: 'y' })).toThrow(
      ConnectorsError
    );
    expect(() => product.delete({ id: '1' })).toThrow(ConnectorsError);
  });

  it('permits every CRUD verb when `operations` is omitted', () => {
    const apiClient = { post: vi.fn() } as unknown as ApiClient;
    const connectors = createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase' },
    });

    const product = (connectors as unknown as Record<string, any>).salesDb
      .Product;
    // `create` is the raw entity-client method (a function), not a throwing
    // stub — proving the gating Proxy is not installed when operations is
    // omitted.
    expect(typeof product.create).toBe('function');
    expect(typeof product.update).toBe('function');
    expect(typeof product.delete).toBe('function');
  });

  it('ignores `operations` for Cat B connectors (no runtime gating)', async () => {
    const post = vi.fn(async () => ({ ok: true }));
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      semanticModel: {
        connector: 'fabric-semanticmodel',
        operations: ['read'],
      },
    });

    await (
      connectors as unknown as Record<string, any>
    ).semanticModel.executeQuery({ query: 'x' });

    expect(post).toHaveBeenCalledWith(
      '/connector-invoke/semanticModel',
      { operation: 'executeQuery', input: { query: 'x' } },
      {
        headers: {
          Accept: 'application/vnd.apache.arrow.stream, application/json',
        },
        responseType: 'arraybuffer',
      }
    );
  });
});

describe('Cat A warehouse mutation return type', () => {
  it('warehouse create selects `result` and returns the DbOperationResult', async () => {
    // Fabric Warehouse (DWSQL) has no T-SQL `OUTPUT` clause, so DAB returns
    // `DbOperationResult { result }` instead of the written row.
    const post = vi.fn(async () => ({
      data: { createProduct: { result: 'success' } },
    }));
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      dw: { connector: 'fabric-warehouse' },
    });

    const result = await (
      connectors as unknown as Record<string, any>
    ).dw.Product.create({ name: 'Widget', price: 10 });

    expect(result).toEqual({ result: 'success' });

    const payload = (post.mock.calls as unknown as unknown[][])[0][1] as {
      query: string;
    };
    const selection = returnSelection(payload.query);
    expect(selection).toContain('result');
    expect(selection).not.toContain('name');
    expect(selection).not.toContain('price');
  });

  it('sql database create selects the columns and returns the row', async () => {
    // Fabric SQL Database (MSSQL) supports `OUTPUT INSERTED.*`, so the written
    // row is read back — the change must not perturb this path.
    const post = vi.fn(async () => ({
      data: { createProduct: { id: '1', name: 'Widget' } },
    }));
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase', entities: { Product } },
    });

    const result = await (
      connectors as unknown as Record<string, any>
    ).salesDb.Product.create({ name: 'Widget' });

    expect(result).toEqual({ id: '1', name: 'Widget' });

    const payload = (post.mock.calls as unknown as unknown[][])[0][1] as {
      query: string;
    };
    const selection = returnSelection(payload.query);
    expect(selection).toContain('id');
    expect(selection).toContain('name');
    expect(selection).toContain('price');
    expect(selection).not.toContain('result');
  });

  // Browser code cannot reference a decorated entity class: bundlers lower the
  // decorators into an invalid class expression and the app fails to parse. The
  // column-list form supplies the same default selection without the class.
  describe('entities supplied as column names', () => {
    it('uses the column list as the default selection for a no-selection read', async () => {
      const post = vi.fn(async () => ({
        data: { products: { items: [{ id: '1', name: 'Widget' }] } },
      }));
      const apiClient = { post } as unknown as ApiClient;

      const connectors = createConnectorsApi(apiClient, {
        salesDb: {
          connector: 'fabric-sqldatabase',
          entities: { Product },
        },
      });

      await (
        connectors as unknown as Record<string, any>
      ).salesDb.Product.findMany();

      const payload = (post.mock.calls as unknown as unknown[][])[0][1] as {
        query: string;
      };
      expect(payload.query).toContain('id');
      expect(payload.query).toContain('name');
      expect(payload.query).toContain('price');
    });

    it('uses the column list to read the row back from a mutation', async () => {
      const post = vi.fn(async () => ({
        data: { createProduct: { id: '1', name: 'Widget' } },
      }));
      const apiClient = { post } as unknown as ApiClient;

      const connectors = createConnectorsApi(apiClient, {
        salesDb: {
          connector: 'fabric-sqldatabase',
          entities: { Product },
        },
      });

      await (
        connectors as unknown as Record<string, any>
      ).salesDb.Product.create({ name: 'Widget' });

      const payload = (post.mock.calls as unknown as unknown[][])[0][1] as {
        query: string;
      };
      const selection = returnSelection(payload.query);
      expect(selection).toContain('id');
      expect(selection).toContain('name');
      expect(selection).toContain('price');
    });

    it('still throws SELECTION_REQUIRED when entities is omitted entirely', async () => {
      const apiClient = { post: vi.fn() } as unknown as ApiClient;

      const connectors = createConnectorsApi(apiClient, {
        salesDb: { connector: 'fabric-sqldatabase' },
      });

      await expect(
        (
          connectors as unknown as Record<string, any>
        ).salesDb.Product.findMany()
      ).rejects.toThrow(/SELECTION_REQUIRED|requires an explicit/);
    });
  });

  it('sql analytics is a read-only surface — create is gated off', () => {
    // The Lakehouse SQL Analytics endpoint only allows `read`, so a write never
    // reaches the mutation builder — it is rejected at runtime.
    const apiClient = { post: vi.fn() } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      lake: { connector: 'fabric-sqlanalytics', operations: ['read'] },
    });

    const product = (connectors as unknown as Record<string, any>).lake.Product;
    expect(() => product.create({ name: 'Widget' })).toThrow(ConnectorsError);
    expect(() => product.create({ name: 'Widget' })).toThrow(
      /OPERATION_NOT_ALLOWED|not in the connector's allowed operations/
    );
  });

  it('supportsReadAfterWrite is true for sql database, false for warehouse', () => {
    expect(supportsReadAfterWrite('fabric-sqldatabase')).toBe(true);
    expect(supportsReadAfterWrite('fabric-warehouse')).toBe(false);
  });

  it('warehouse update selects `result` and returns the DbOperationResult', async () => {
    const post = vi.fn(async () => ({
      data: { updateProduct: { result: 'success' } },
    }));
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      dw: { connector: 'fabric-warehouse' },
    });

    const result = await (
      connectors as unknown as Record<string, any>
    ).dw.Product.update({ id: '1' }, { name: 'Widget' });

    expect(result).toEqual({ result: 'success' });

    const payload = (post.mock.calls as unknown as unknown[][])[0][1] as {
      query: string;
    };
    const selection = returnSelection(payload.query);
    expect(selection).toContain('result');
    expect(selection).not.toContain('name');
  });

  it('update forwards the scalar column set into the mutation item', async () => {
    const post = vi.fn(async () => ({
      data: { updateProduct: { id: '1', name: 'Widget', price: 10 } },
    }));
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase' },
    });

    await (connectors as unknown as Record<string, any>).salesDb.Product.update(
      { id: '1' },
      { name: 'Widget', price: 10 }
    );

    const payload = (post.mock.calls as unknown as unknown[][])[0][1] as {
      query: string;
    };
    // The updated columns are inlined into the `item:` argument block.
    const itemBlock = payload.query.slice(
      payload.query.indexOf('item:'),
      payload.query.lastIndexOf(') {')
    );
    expect(payload.query).toContain('updateProduct');
    expect(itemBlock).toContain('Widget');
    expect(itemBlock).toContain('10');
  });

  it('warehouse delete selects `result` and returns the DbOperationResult', async () => {
    const post = vi.fn(async () => ({
      data: { deleteProduct: { result: 'success' } },
    }));
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      dw: { connector: 'fabric-warehouse' },
    });

    const result = await (
      connectors as unknown as Record<string, any>
    ).dw.Product.delete({ id: '1' });

    expect(result).toEqual({ result: 'success' });

    const payload = (post.mock.calls as unknown as unknown[][])[0][1] as {
      query: string;
    };
    const selection = returnSelection(payload.query);
    expect(selection).toContain('result');
    expect(selection).not.toContain('id');
  });

  it('throws MUTATION_NO_RESULT when a mutation matches no row (null field)', async () => {
    // DAB returns a `null` mutation field when the by-key update/delete matched
    // no row. The guard must treat that as an error, not a successful result.
    const post = vi.fn(async () => ({ data: { updateProduct: null } }));
    const apiClient = { post } as unknown as ApiClient;

    const connectors = createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase' },
    });

    const product = (connectors as unknown as Record<string, any>).salesDb
      .Product;

    await expect(product.update({ id: '1' }, { name: 'y' })).rejects.toThrow(
      /MUTATION_NO_RESULT|returned no data/
    );
  });
});

describe('Cat A read overload dispatch (findMany / findFirst)', () => {
  /** An empty result set; the assertions target the sent query, not the rows. */
  const emptyRows = () => ({ data: { products: { items: [] } } });

  /** The GraphQL document sent for the single read call captured by `post`. */
  function readQuery(post: ReturnType<typeof vi.fn>): string {
    const payload = (post.mock.calls as unknown as unknown[][])[0][1] as {
      query: string;
    };
    return payload.query;
  }

  /** A SQL DB connector with `Product` registered, so no-selection reads have a full-row default. */
  function salesDb(post: ReturnType<typeof vi.fn>): Record<string, any> {
    const apiClient = { post } as unknown as ApiClient;
    return createConnectorsApi(apiClient, {
      salesDb: { connector: 'fabric-sqldatabase', entities: { Product } },
    }) as unknown as Record<string, any>;
  }

  it('findMany(fields, filter) selects the fields and applies the filter', async () => {
    const post = vi.fn(emptyRows);
    await salesDb(post).salesDb.Product.findMany(['name'], {
      price: { eq: 999 },
    });
    const q = readQuery(post);
    expect(q).toContain('name');
    expect(q).toContain('999');
  });

  it('findMany(filter) returns the full row and applies the filter', async () => {
    const post = vi.fn(emptyRows);
    await salesDb(post).salesDb.Product.findMany({ price: { eq: 999 } });
    const q = readQuery(post);
    expect(q).toContain('name'); // full row, since entities are registered
    expect(q).toContain('999');
  });

  it('findMany(undefined, filter) still applies the filter (regression)', async () => {
    const post = vi.fn(emptyRows);
    await salesDb(post).salesDb.Product.findMany(undefined, {
      price: { eq: 999 },
    });
    expect(readQuery(post)).toContain('999');
  });

  it('findMany([], filter) treats an empty selection as full row and applies the filter', async () => {
    const post = vi.fn(emptyRows);
    await salesDb(post).salesDb.Product.findMany([], { price: { eq: 999 } });
    const q = readQuery(post);
    expect(q).toContain('name');
    expect(q).toContain('999');
  });

  it('findMany(fields) applies no filter', async () => {
    const post = vi.fn(emptyRows);
    await salesDb(post).salesDb.Product.findMany(['name']);
    expect(readQuery(post)).not.toContain('999');
  });

  it('findFirst(undefined, filter) still applies the filter (regression)', async () => {
    const post = vi.fn(emptyRows);
    await salesDb(post).salesDb.Product.findFirst(undefined, {
      price: { eq: 999 },
    });
    expect(readQuery(post)).toContain('999');
  });

  it('findFirst(filter) returns the full row and applies the filter', async () => {
    const post = vi.fn(emptyRows);
    await salesDb(post).salesDb.Product.findFirst({ price: { eq: 999 } });
    const q = readQuery(post);
    expect(q).toContain('name');
    expect(q).toContain('999');
  });
});
