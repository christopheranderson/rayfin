import {
  ConnectorSchemaAnalyzer,
  SchemaAnalyzer,
} from '@microsoft/rayfin-core/analysis';
import {
  entity,
  int,
  many,
  one,
  text,
  uuid,
} from '@microsoft/rayfin-core/decorators';
import { describe, expect, it, vi } from 'vitest';

import { Source } from '../category-a/schema/source';

describe('SchemaAnalyzer - connector metadata exposure', () => {
  describe('source mapping', () => {
    it('exposes source on the analysis result when the class extends Source({...})', () => {
      @entity()
      class Product extends Source({
        schema: 'SalesLT',
        table: 'Product',
      }) {
        @uuid()
        id!: string;
      }
      const [result] = new ConnectorSchemaAnalyzer(
        [Product],
        'mssql'
      ).analyzeEntities();
      expect(result.source).toEqual({ schema: 'SalesLT', table: 'Product' });
    });

    it('applies default schema and class-name table when Source() is bare', () => {
      @entity()
      class Customer extends Source() {
        @uuid()
        id!: string;
      }
      const [result] = new ConnectorSchemaAnalyzer(
        [Customer],
        'mssql'
      ).analyzeEntities();
      expect(result.source).toEqual({ schema: 'dbo', table: 'Customer' });
    });

    it('omits source on entities that do not extend Source()', () => {
      @entity()
      class Plain {
        @uuid()
        id!: string;
      }
      const [result] = new SchemaAnalyzer([Plain], 'mssql').analyzeEntities();
      expect(result.source).toBeUndefined();
    });
  });

  describe('field-level column', () => {
    it('exposes columnName from field decorators', () => {
      @entity()
      class Product {
        @uuid()
        id!: string;
        @int({
          column: 'product_category_id',
        })
        categoryId!: number;
        @text({ column: 'Name' })
        name!: string;
      }
      const [result] = new SchemaAnalyzer([Product], 'mssql').analyzeEntities();
      const byName = (n: string) => result.fields.find((f) => f.name === n)!;
      expect(byName('categoryId').columnName).toBe('product_category_id');
      expect(byName('name').columnName).toBe('Name');
      // Untouched field should have none.
      expect(byName('id').columnName).toBeUndefined();
    });
  });

  describe('relationship sourceFields/targetFields', () => {
    it('exposes simple FK declarations on @one() relationships', () => {
      @entity()
      class Category extends Source({ table: 'Category' }) {
        @uuid()
        id!: string;
      }
      @entity()
      class Product extends Source({ table: 'Product' }) {
        @uuid()
        id!: string;
        @int()
        categoryId!: number;
        @one(() => Category, {
          sourceFields: ['categoryId'],
          targetFields: ['id'],
        })
        category!: Category;
      }
      const [, productResult] = new ConnectorSchemaAnalyzer(
        [Category, Product],
        'mssql'
      ).analyzeEntities();
      const categoryField = productResult.fields.find(
        (f) => f.name === 'category'
      )!;
      expect(categoryField.sourceFields).toEqual(['categoryId']);
      expect(categoryField.targetFields).toEqual(['id']);
    });

    it('exposes composite FK declarations', () => {
      @entity()
      class Order extends Source({ table: 'Order' }) {
        @uuid()
        id!: string;
        @int()
        lineNumber!: number;
      }
      @entity()
      class OrderLine extends Source({ table: 'OrderLine' }) {
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
      const [, orderLineResult] = new ConnectorSchemaAnalyzer(
        [Order, OrderLine],
        'mssql'
      ).analyzeEntities();
      const orderField = orderLineResult.fields.find(
        (f) => f.name === 'order'
      )!;
      expect(orderField.sourceFields).toEqual(['orderId', 'lineId']);
      expect(orderField.targetFields).toEqual(['id', 'lineNumber']);
    });

    it('exposes FK declarations on inverse @many() relationships', () => {
      @entity()
      class Product extends Source({ table: 'Product' }) {
        @uuid()
        id!: string;
        @uuid()
        categoryId!: string;
      }
      @entity()
      class Category extends Source({ table: 'Category' }) {
        @uuid()
        id!: string;
        @many(() => Product, {
          sourceFields: ['id'],
          targetFields: ['categoryId'],
        })
        products!: Product[];
      }
      const [, categoryResult] = new ConnectorSchemaAnalyzer(
        [Product, Category],
        'mssql'
      ).analyzeEntities();
      const productsField = categoryResult.fields.find(
        (f) => f.name === 'products'
      )!;
      expect(productsField.sourceFields).toEqual(['id']);
      expect(productsField.targetFields).toEqual(['categoryId']);
    });

    it('omits sourceFields/targetFields when relationship has none', () => {
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
      const [, productResult] = new SchemaAnalyzer(
        [Category, Product],
        'mssql'
      ).analyzeEntities();
      const categoryField = productResult.fields.find(
        (f) => f.name === 'category'
      )!;
      expect(categoryField.sourceFields).toBeUndefined();
      expect(categoryField.targetFields).toBeUndefined();
    });

    it('allows @many() / @one() across two classes that both extend Source({...})', () => {
      @entity()
      class DailyGoal extends Source({ schema: 'dbo', table: 'DailyGoal' }) {
        @uuid()
        id!: string;
        @text()
        userId!: string;
        @one(() => DailySummary, {
          sourceFields: ['userId'],
          targetFields: ['userId'],
        })
        dailySummary!: DailySummary;
      }
      @entity()
      class DailySummary extends Source({
        schema: 'dbo',
        table: 'DailySummary',
      }) {
        @text()
        userId!: string;
        @many(() => DailyGoal, {
          sourceFields: ['userId'],
          targetFields: ['userId'],
        })
        goals?: DailyGoal[];
      }
      const [, summaryResult] = new ConnectorSchemaAnalyzer(
        [DailyGoal, DailySummary],
        'mssql'
      ).analyzeEntities();
      const goalsField = summaryResult.fields.find((f) => f.name === 'goals')!;
      expect(goalsField.sourceFields).toEqual(['userId']);
      expect(goalsField.targetFields).toEqual(['userId']);
    });
  });
});

describe('SchemaAnalyzer - diagnostic log sink', () => {
  // The injected `log` sink is how the CLI routes verbose schema
  // diagnostics (dab-config-generator passes `console.log` only when
  // `--verbose` is set). These pin both directions of that contract.
  it('routes analyzer diagnostics to the injected log sink', () => {
    @entity()
    class Widget {
      @uuid()
      id!: string;
      @int()
      count!: number;
    }
    const log = vi.fn();
    new SchemaAnalyzer([Widget], 'mssql', { log }).analyzeEntities();
    expect(log).toHaveBeenCalled();
  });

  it('defaults the log sink to console.log when none is injected', () => {
    @entity()
    class Widget {
      @uuid()
      id!: string;
      @int()
      count!: number;
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    new SchemaAnalyzer([Widget], 'mssql').analyzeEntities();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
