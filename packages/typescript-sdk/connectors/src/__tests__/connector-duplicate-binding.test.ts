import { ConnectorSchemaAnalyzer } from '@microsoft/rayfin-core/analysis';
import { entity, uuid } from '@microsoft/rayfin-core/decorators';
import { describe, it, expect } from 'vitest';

import { Source } from '../category-a/schema/source';

/**
 * Early client-side validation for duplicate source-table bindings.
 *
 * Two entities that resolve to the same schema + table produce duplicate
 * source-table bindings that the workload otherwise rejects late during
 * `applyconfig` with a cryptic host error. These tests lock in that the
 * analyzer catches the conflict up front with an actionable message.
 */
function analyze(...classes: Array<new (...args: never[]) => object>) {
  return new ConnectorSchemaAnalyzer(
    classes as never,
    'mssql'
  ).analyzeEntities();
}

describe('ConnectorSchemaAnalyzer - duplicate source-table binding', () => {
  it('rejects two entities that bind to the same explicit table', () => {
    @entity()
    class Orders extends Source({ table: 'Orders' }) {
      @uuid()
      id!: string;
    }
    @entity()
    class Sales extends Source({ table: 'Orders' }) {
      @uuid()
      id!: string;
    }

    expect(() => analyze(Orders, Sales)).toThrow(
      /binds to source table 'dbo\.Orders', which is already bound by entity 'Orders'/
    );
  });

  it('detects the conflict case-insensitively', () => {
    @entity()
    class Orders extends Source({ table: 'Orders' }) {
      @uuid()
      id!: string;
    }
    @entity()
    class Sales extends Source({ table: 'orders' }) {
      @uuid()
      id!: string;
    }

    expect(() => analyze(Orders, Sales)).toThrow(
      /already bound by entity 'Orders'/
    );
  });

  it('treats different schemas on the same table name as distinct bindings', () => {
    @entity()
    class Orders extends Source({ schema: 'sales', table: 'Orders' }) {
      @uuid()
      id!: string;
    }
    @entity()
    class Archive extends Source({ schema: 'history', table: 'Orders' }) {
      @uuid()
      id!: string;
    }

    expect(() => analyze(Orders, Archive)).not.toThrow();
  });

  it('allows entities bound to distinct tables', () => {
    @entity()
    class Orders extends Source({ table: 'Orders' }) {
      @uuid()
      id!: string;
    }
    @entity()
    class Customers extends Source({ table: 'Customers' }) {
      @uuid()
      id!: string;
    }

    expect(() => analyze(Orders, Customers)).not.toThrow();
  });
});
