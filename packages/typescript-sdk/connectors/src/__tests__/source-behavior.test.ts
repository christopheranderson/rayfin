/**
 * `Source()` connector base-class behavior, relocated with `Source` into
 * `@microsoft/rayfin-connectors`. Covers the connector relationship options
 * (`sourceFields` / `targetFields`) on `@one`/`@many`, connector source mapping
 * (schema/table) via the `Source` base class, and the data-path analyzer guard
 * that rejects `Source` as connector-only.
 *
 * These blocks moved out of core's `decorators` / `validation-errors` suites
 * because `Source` now lives in this package — core can no longer import it.
 */

import {
  entity,
  uuid,
  int,
  text,
  one,
  many,
  RayfinEntity,
} from '@microsoft/rayfin-core';
import type { EntityMetadata } from '@microsoft/rayfin-core';
import {
  SchemaAnalyzer,
  SchemaValidationError,
} from '@microsoft/rayfin-core/analysis';
import { describe, it, expect } from 'vitest';

import { Source } from '../category-a/schema/source';

function getMeta(cls: unknown): EntityMetadata {
  return (cls as any)[Symbol.metadata]?.[RayfinEntity] as EntityMetadata;
}

describe('Connector relationship options (sourceFields, targetFields)', () => {
  it('stores simple sourceFields/targetFields on @one()', () => {
    @entity()
    class Category extends Source({ table: 'Categories', primaryKey: ['id'] }) {
      @uuid()
      id!: string;
    }
    @entity()
    class Product extends Source({ table: 'Products', primaryKey: ['id'] }) {
      @uuid()
      id!: string;
      @uuid()
      categoryId!: string;
      @one(() => Category, {
        sourceFields: ['categoryId'],
        targetFields: ['id'],
      })
      category!: Category;
    }
    const meta = getMeta(Product);
    expect(meta.fields.category.relationship?.sourceFields).toEqual([
      'categoryId',
    ]);
    expect(meta.fields.category.relationship?.targetFields).toEqual(['id']);
  });

  it('stores inverse sourceFields/targetFields on @many()', () => {
    @entity()
    class Product extends Source({ table: 'Products', primaryKey: ['id'] }) {
      @uuid()
      id!: string;
      @uuid()
      categoryId!: string;
    }
    @entity()
    class Category extends Source({ table: 'Categories', primaryKey: ['id'] }) {
      @uuid()
      id!: string;
      @many(() => Product, {
        sourceFields: ['id'],
        targetFields: ['categoryId'],
      })
      products!: Product[];
    }
    const meta = getMeta(Category);
    expect(meta.fields.products.relationship?.sourceFields).toEqual(['id']);
    expect(meta.fields.products.relationship?.targetFields).toEqual([
      'categoryId',
    ]);
  });

  it('stores composite sourceFields/targetFields on @one()', () => {
    @entity()
    class Order extends Source({
      table: 'Orders',
      primaryKey: ['id', 'lineNumber'],
    }) {
      @uuid()
      id!: string;
      @int()
      lineNumber!: number;
    }
    @entity()
    class OrderLineRef extends Source({
      table: 'OrderLines',
      primaryKey: ['id'],
    }) {
      @uuid()
      id!: string;
      @uuid()
      orderId!: string;
      @int()
      lineId!: number;
      @one(() => Order, {
        sourceFields: ['orderId', 'lineId'],
        targetFields: ['id', 'lineNumber'],
      })
      order!: Order;
    }
    const meta = getMeta(OrderLineRef);
    const rel = meta.fields.order.relationship;
    expect(rel?.sourceFields).toEqual(['orderId', 'lineId']);
    expect(rel?.targetFields).toEqual(['id', 'lineNumber']);
    expect(rel?.sourceFields?.length).toBe(rel?.targetFields?.length);
  });

  it('omits sourceFields/targetFields when not provided on @one()', () => {
    @entity()
    class Category {
      @uuid()
      id!: string;
    }
    @entity()
    class Product {
      @uuid()
      id!: string;
      @one(() => Category)
      category!: Category;
    }
    const meta = getMeta(Product);
    expect(meta.fields.category.relationship?.sourceFields).toBeUndefined();
    expect(meta.fields.category.relationship?.targetFields).toBeUndefined();
  });

  it('omits sourceFields/targetFields when not provided on @many()', () => {
    @entity()
    class Product {
      @uuid()
      id!: string;
    }
    @entity()
    class Category {
      @uuid()
      id!: string;
      @many(() => Product)
      products!: Product[];
    }
    const meta = getMeta(Category);
    expect(meta.fields.products.relationship?.sourceFields).toBeUndefined();
    expect(meta.fields.products.relationship?.targetFields).toBeUndefined();
  });
});

describe('Connector source mapping (Source base class)', () => {
  it('stores schema and table verbatim from Source({...})', () => {
    @entity()
    class ProductCategory extends Source({
      schema: 'SalesLT',
      table: '[Product Category]',
    }) {
      @uuid()
      id!: string;
    }
    const meta = getMeta(ProductCategory);
    expect(meta.source).toEqual({
      schema: 'SalesLT',
      table: '[Product Category]',
    });
  });

  it('does not set source on entities that do not extend Source()', () => {
    @entity()
    class PlainEntity {
      @uuid()
      id!: string;
    }
    const meta = getMeta(PlainEntity);
    expect(meta.source).toBeUndefined();
  });
});

describe('Source data-path analyzer guard (connector-only)', () => {
  describe('Source is connector-only on the data path', () => {
    it('should reject a data-path entity that extends Source', () => {
      @entity()
      class Connectorish extends Source({
        table: 'Things',
        primaryKey: ['id'],
      }) {
        @uuid()
        id!: string;
      }

      const analyzer = new SchemaAnalyzer([Connectorish], 'mssql');
      expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

      try {
        new SchemaAnalyzer([Connectorish], 'mssql').analyzeEntities();
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const sourceError = error.errors.find((e) =>
            e.message.includes('connector-only')
          );
          expect(sourceError).toBeDefined();
          expect(sourceError!.entity).toBe('Connectorish');
        }
      }
    });

    it('should not flag an ordinary data-path entity that does not extend Source', () => {
      @entity()
      class PlainThing {
        @uuid()
        id!: string;

        @text()
        name!: string;
      }

      const analyzer = new SchemaAnalyzer([PlainThing], 'mssql');
      expect(() => analyzer.analyzeEntities()).not.toThrow();
    });
  });

  describe('Custom FK options are connector-only on the data path', () => {
    it('should reject a data-path host whose relationship targets a connector entity with custom FK (cross-path)', () => {
      @entity()
      class ConnectorCity extends Source({
        table: 'City',
        primaryKey: ['id'],
      }) {
        @uuid()
        id!: string;
      }
      @entity()
      class DataOrder {
        @uuid()
        id!: string;

        @uuid()
        cityId!: string;

        @one(() => ConnectorCity, {
          sourceFields: ['cityId'],
          targetFields: ['id'],
        })
        city!: ConnectorCity;
      }

      // The data-path analyzer only receives the data-path host. Assert the
      // host-based custom-FK guard fired for the `city` relationship — not
      // merely that some error was thrown (the connector target is also absent
      // from the schema, which raises its own separate error).
      const analyzer = new SchemaAnalyzer([DataOrder], 'mssql');
      let caught: SchemaValidationError | undefined;
      try {
        analyzer.analyzeEntities();
      } catch (e) {
        caught = e as SchemaValidationError;
      }
      expect(caught).toBeInstanceOf(SchemaValidationError);
      expect(
        caught!.errors.some(
          (err) =>
            err.field === 'city' && /not supported here/.test(err.message)
        )
      ).toBe(true);
    });
  });
});
