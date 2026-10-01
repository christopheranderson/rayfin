import { entity, int, one, text } from '@microsoft/rayfin-core';
import { describe, expect, it } from 'vitest';

import { ConnectorsError } from './Connectors';
import { Source } from './category-a/schema/source';
import {
  buildByPkQuery,
  buildCreateMutation,
  buildDeleteMutation,
  buildUpdateMutation,
  byPkQueryField,
  entityReturnColumns,
  supportsReadAfterWrite,
} from './utils';

/** The return selection set of a built mutation — the block after the last `) {`. */
function returnSelection(query: string): string {
  return query.slice(query.lastIndexOf(') {') + 3);
}

describe('supportsReadAfterWrite', () => {
  it('is true for connectors that read the written row back', () => {
    expect(supportsReadAfterWrite('fabric-sqldatabase')).toBe(true);
    expect(supportsReadAfterWrite('fabric-sqlanalytics')).toBe(true);
  });

  it('is false only for warehouse (no T-SQL OUTPUT clause)', () => {
    expect(supportsReadAfterWrite('fabric-warehouse')).toBe(false);
  });
});

describe('buildCreateMutation', () => {
  it('requests exactly the provided return columns (the full row)', () => {
    const selection = returnSelection(
      buildCreateMutation('Product', { quantity: 5 }, false, [
        'id',
        'quantity',
        'createdUtc',
      ])
    );
    expect(selection).toContain('id');
    expect(selection).toContain('quantity');
    expect(selection).toContain('createdUtc');
    expect(selection).not.toContain('result');
  });

  it('selects only `result` when the connector returns a DbOperationResult', () => {
    const selection = returnSelection(
      buildCreateMutation('Product', { name: 'Widget', price: 10 }, true, [
        'id',
        'name',
      ])
    );
    expect(selection).toContain('result');
    expect(selection).not.toContain('name');
    expect(selection).not.toContain('id');
  });

  it('omits input columns whose value is undefined from the item', () => {
    const query = buildCreateMutation(
      'Product',
      { name: 'Widget', price: undefined },
      false,
      ['name', 'price']
    );
    // `price` is undefined so it is not written into the create item…
    expect(query).toContain('item: { name: "Widget" }');
    // …but it is still requested back in the return selection.
    expect(returnSelection(query)).toContain('price');
  });
});

describe('entityReturnColumns', () => {
  it('lists an entity\u2019s scalar columns and excludes relationships', () => {
    class Manager extends Source({ table: 'Manager', primaryKey: ['id'] }) {
      @int({ column: 'Id' })
      id!: number;
    }

    @entity()
    class Employee extends Source({ table: 'Employee', primaryKey: ['id'] }) {
      @int({ column: 'Id' })
      id!: number;

      @text({ column: 'FullName' })
      fullName!: string;

      @one(() => Manager, { sourceFields: ['id'], targetFields: ['id'] })
      manager?: Manager;
    }

    const columns = entityReturnColumns(Employee);
    expect(columns).toContain('id');
    expect(columns).toContain('fullName');
    expect(columns).not.toContain('manager');
  });

  it('uses the property name for the GraphQL selection regardless of column', () => {
    @entity()
    class Widget extends Source({ table: 'Widget', primaryKey: ['id'] }) {
      @int({ column: 'Id' })
      id!: number;

      @text({ column: 'Category_ID' })
      category!: string;
    }

    const columns = entityReturnColumns(Widget);
    expect(columns).toContain('category');
    expect(columns).not.toContain('Category_ID');
  });
});

describe('mutation selection fallback (no registered entity)', () => {
  /** Grab the thrown ConnectorsError so its code can be asserted. */
  function caught(fn: () => unknown): ConnectorsError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorsError);
      return error as ConnectorsError;
    }
    throw new Error('expected the builder to throw, but it did not');
  }

  it('create falls back to the supplied input columns when no return columns are given', () => {
    const selection = returnSelection(
      buildCreateMutation('Product', { name: 'Widget', price: 10 })
    );
    expect(selection).toContain('name');
    expect(selection).toContain('price');
    expect(selection).not.toContain('result');
  });

  it('update falls back to the where and data columns when no return columns are given', () => {
    const selection = returnSelection(
      buildUpdateMutation('Product', { id: '1' }, { name: 'Widget' })
    );
    expect(selection).toContain('id');
    expect(selection).toContain('name');
    expect(selection).not.toContain('result');
  });

  it('create throws when no entity is registered and no input is supplied', () => {
    const error = caught(() => buildCreateMutation('Product', {}));
    expect(error.code).toBe('EMPTY_MUTATION_SELECTION');
  });

  it('create still selects only `result` for a warehouse insert with empty input', () => {
    const selection = returnSelection(buildCreateMutation('Product', {}, true));
    expect(selection).toContain('result');
  });
});

describe('buildUpdateMutation', () => {
  it('requests exactly the provided return columns (the full row)', () => {
    const selection = returnSelection(
      buildUpdateMutation('Product', { id: '1' }, { name: 'Widget' }, false, [
        'id',
        'name',
        'updatedUtc',
      ])
    );
    expect(selection).toContain('id');
    expect(selection).toContain('name');
    expect(selection).toContain('updatedUtc');
    expect(selection).not.toContain('result');
  });

  it('selects only `result` when the connector returns a DbOperationResult', () => {
    const selection = returnSelection(
      buildUpdateMutation('Product', { id: '1' }, { name: 'Widget' }, true, [
        'id',
        'name',
      ])
    );
    expect(selection).toContain('result');
    expect(selection).not.toContain('id');
    expect(selection).not.toContain('name');
  });
});

describe('buildDeleteMutation', () => {
  it('requests the provided return columns (the full row)', () => {
    const selection = returnSelection(
      buildDeleteMutation('Product', { id: '1' }, false, ['id', 'name'])
    );
    expect(selection).toContain('id');
    expect(selection).toContain('name');
    expect(selection).not.toContain('result');
  });

  it('falls back to the where-key columns when no return columns are given', () => {
    const selection = returnSelection(
      buildDeleteMutation('Product', { id: '1' })
    );
    expect(selection).toContain('id');
    expect(selection).not.toContain('result');
  });

  it('selects only `result` when the connector returns a DbOperationResult', () => {
    const selection = returnSelection(
      buildDeleteMutation('Product', { id: '1' }, true)
    );
    expect(selection).toContain('result');
    expect(selection).not.toContain('id');
  });
});

describe('column-name validation (identifier injection guard)', () => {
  /** Grab the thrown ConnectorsError so its code can be asserted. */
  function caught(fn: () => unknown): ConnectorsError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorsError);
      return error as ConnectorsError;
    }
    throw new Error('expected the builder to throw, but it did not');
  }

  it('rejects an item column name that is not a GraphQL Name', () => {
    const error = caught(() =>
      buildCreateMutation('Product', { 'name) { id } evil(x': 'Widget' })
    );
    expect(error.code).toBe('INVALID_COLUMN_NAME');
  });

  it('rejects a where-key name that is not a GraphQL Name', () => {
    const error = caught(() =>
      buildDeleteMutation('Product', { 'id, hacked': '1' })
    );
    expect(error.code).toBe('INVALID_COLUMN_NAME');
  });

  it('rejects a bad name in either the where or the item of an update', () => {
    expect(() =>
      buildUpdateMutation('Product', { 'bad key': '1' }, { name: 'Widget' })
    ).toThrow(ConnectorsError);
    expect(() =>
      buildUpdateMutation('Product', { id: '1' }, { 'bad-column': 'Widget' })
    ).toThrow(ConnectorsError);
  });

  it('rejects a leading-digit name (not a valid identifier start)', () => {
    const error = caught(() =>
      buildCreateMutation('Product', { '1name': 'Widget' })
    );
    expect(error.code).toBe('INVALID_COLUMN_NAME');
  });

  it('allows underscore-led and mixed-case identifiers', () => {
    expect(() =>
      buildCreateMutation('Product', { _tenant_Id: 't1', priceUSD: 10 })
    ).not.toThrow();
  });

  it('skips validation for undefined-valued columns (they are filtered out)', () => {
    expect(() =>
      buildCreateMutation('Product', { 'bad key': undefined, name: 'Widget' })
    ).not.toThrow();
  });
});

describe('byPkQueryField', () => {
  it('lower-cases the first letter and appends _by_pk (DAB query naming)', () => {
    expect(byPkQueryField('Product')).toBe('product_by_pk');
    expect(byPkQueryField('Reading')).toBe('reading_by_pk');
  });
});

describe('buildByPkQuery', () => {
  /** The selection block of a by-pk query — the part after `) {`. */
  function selectionOf(query: string): string {
    return query.slice(query.lastIndexOf(') {') + 3);
  }

  it('queries the <entity>_by_pk field with the key as arguments', () => {
    const query = buildByPkQuery('Product', { id: '1' });
    expect(query).toContain('product_by_pk(id: "1")');
    expect(query).toContain('query {');
  });

  it('passes every column of a composite key as a separate argument', () => {
    const query = buildByPkQuery('Reading', { sensorId: 's1', ts: 42 });
    expect(query).toContain('reading_by_pk(sensorId: "s1", ts: 42)');
    const selection = selectionOf(query);
    expect(selection).toContain('sensorId');
    expect(selection).toContain('ts');
  });

  it('selects the key columns (the only columns known at runtime)', () => {
    const selection = selectionOf(buildByPkQuery('Product', { id: '1' }));
    expect(selection).toContain('id');
    expect(selection).not.toContain('result');
  });

  it('selects the requested columns when a projection is given', () => {
    const selection = selectionOf(
      buildByPkQuery('Product', { id: '1' }, ['name', 'price'])
    );
    expect(selection).toContain('name');
    expect(selection).toContain('price');
    expect(selection).not.toContain('id');
  });

  it('falls back to the key columns when the projection is empty', () => {
    const selection = selectionOf(buildByPkQuery('Product', { id: '1' }, []));
    expect(selection).toContain('id');
  });

  it('rejects a projected column name that is not a GraphQL Name', () => {
    expect(() =>
      buildByPkQuery('Product', { id: '1' }, ['name) { x } evil('])
    ).toThrow(ConnectorsError);
  });

  it('rejects a key column name that is not a GraphQL Name', () => {
    expect(() => buildByPkQuery('Product', { 'id) { x } evil(': '1' })).toThrow(
      ConnectorsError
    );
  });
});
