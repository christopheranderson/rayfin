import { describe, expect, it } from 'vitest';

import { splitV1Rows, toQueryResult, transformV1 } from './queryResult';
import type { KustoQueryResponse } from './types';

/** A single-table Kusto v1 document (the common query shape). */
function singleTable(): KustoQueryResponse {
  return {
    Tables: [
      {
        TableName: 'Table_0',
        Columns: [
          { ColumnName: 'State', ColumnType: 'string' },
          { ColumnName: 'Count', ColumnType: 'long' },
        ],
        Rows: [
          ['WA', 3],
          ['OR', 5],
        ],
      },
    ],
  };
}

/**
 * A multi-table Kusto v1 document whose last table is the Table of Contents,
 * in the **standard** shape the Kusto v1 REST endpoint returns: the ToC carries
 * the logical result name in the `Name` column (`PrimaryResult`) and leaves
 * `PrettyName` empty. The ToC keeps only `Kind == "QueryResult"` tables; the
 * `QueryProperties` metadata table is dropped.
 */
function multiTableWithToc(): KustoQueryResponse {
  return {
    Tables: [
      {
        TableName: 'Table_0',
        Columns: [{ ColumnName: 'State', ColumnType: 'string' }],
        Rows: [['WA'], ['OR']],
      },
      {
        TableName: 'Table_1',
        Columns: [{ ColumnName: 'Value', ColumnType: 'string' }],
        Rows: [['@ExtendedProperties']],
      },
      {
        TableName: 'Table_2',
        Columns: [
          { ColumnName: 'Ordinal', ColumnType: 'long' },
          { ColumnName: 'Kind', ColumnType: 'string' },
          { ColumnName: 'Name', ColumnType: 'string' },
          { ColumnName: 'Id', ColumnType: 'string' },
          { ColumnName: 'PrettyName', ColumnType: 'string' },
        ],
        Rows: [
          [0, 'QueryResult', 'PrimaryResult', '', ''],
          [1, 'QueryProperties', '@ExtendedProperties', '', ''],
        ],
      },
    ],
  };
}

describe('transformV1', () => {
  it('maps a single table (ColumnName/ColumnType -> name/type)', () => {
    const { tables, errors } = transformV1(singleTable());
    expect(errors).toEqual([]);
    expect(tables).toEqual([
      {
        name: 'Table_0',
        columns: [
          { name: 'State', type: 'string' },
          { name: 'Count', type: 'long' },
        ],
        rows: [
          ['WA', 3],
          ['OR', 5],
        ],
      },
    ]);
  });

  it('keeps only QueryResult tables and renames by the Name column when PrettyName is empty', () => {
    const { tables } = transformV1(multiTableWithToc());
    expect(tables).toHaveLength(1);
    // Standard ToC: Name = 'PrimaryResult', PrettyName = '' -> use Name.
    expect(tables[0]?.name).toBe('PrimaryResult');
    expect(tables[0]?.rows).toEqual([['WA'], ['OR']]);
  });

  it('prefers PrettyName over Name when PrettyName is present', () => {
    const { tables } = transformV1({
      Tables: [
        {
          TableName: 'Table_0',
          Columns: [{ ColumnName: 'State', ColumnType: 'string' }],
          Rows: [['WA']],
        },
        {
          TableName: 'Table_1',
          Columns: [
            { ColumnName: 'Kind', ColumnType: 'string' },
            { ColumnName: 'Name', ColumnType: 'string' },
            { ColumnName: 'PrettyName', ColumnType: 'string' },
          ],
          Rows: [['QueryResult', 'PrimaryResult', 'Friendly Name']],
        },
      ],
    });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe('Friendly Name');
  });

  it('keeps the transport name when both Name and PrettyName are empty', () => {
    const { tables } = transformV1({
      Tables: [
        {
          TableName: 'Table_0',
          Columns: [{ ColumnName: 'State', ColumnType: 'string' }],
          Rows: [['WA']],
        },
        {
          TableName: 'Table_1',
          Columns: [
            { ColumnName: 'Kind', ColumnType: 'string' },
            { ColumnName: 'Name', ColumnType: 'string' },
            { ColumnName: 'PrettyName', ColumnType: 'string' },
          ],
          Rows: [['QueryResult', '', '']],
        },
      ],
    });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe('Table_0');
  });

  it('returns nothing for an empty result', () => {
    expect(transformV1({ Tables: [] })).toEqual({ tables: [], errors: [] });
    expect(transformV1({})).toEqual({ tables: [], errors: [] });
  });

  it('strips a trailing error object and surfaces its exceptions', () => {
    const { tables, errors } = transformV1({
      Tables: [
        {
          TableName: 'Table_0',
          Columns: [{ ColumnName: 'X', ColumnType: 'long' }],
          Rows: [[1], [2], { Exceptions: ['soft warning'] }],
        },
      ],
    });
    // The trailing non-array error object is removed from the data rows.
    expect(tables[0]?.rows).toEqual([[1], [2]]);
    expect(errors).toEqual(['soft warning']);
  });

  it('falls back to DataType when ColumnType is absent', () => {
    const { tables } = transformV1({
      Tables: [
        {
          TableName: 'Table_0',
          Columns: [{ ColumnName: 'When', DataType: 'DateTime' }],
          Rows: [['2026-01-01T00:00:00Z']],
        },
      ],
    });
    expect(tables[0]?.columns).toEqual([{ name: 'When', type: 'DateTime' }]);
  });
});

describe('toQueryResult', () => {
  it('normalizes a single table to a success result', () => {
    const result = toQueryResult(singleTable());
    expect(result).toEqual({
      status: 'success',
      clientRequestId: '',
      tables: [
        {
          name: 'Table_0',
          columns: [
            { name: 'State', type: 'string' },
            { name: 'Count', type: 'long' },
          ],
          rows: [
            ['WA', 3],
            ['OR', 5],
          ],
        },
      ],
    });
  });

  it('threads out-of-band correlation ids (never on the wire)', () => {
    const result = toQueryResult(singleTable(), {
      clientRequestId: 'KPC.rayfin_kusto_v1;abc',
      activityId: 'activity-7',
    });
    expect(result.status).toBe('success');
    expect(result.clientRequestId).toBe('KPC.rayfin_kusto_v1;abc');
    expect(result.activityId).toBe('activity-7');
  });

  it('returns an empty successful result when tables are missing', () => {
    expect(toQueryResult({})).toEqual({
      status: 'success',
      clientRequestId: '',
      tables: [],
    });
  });

  it('accepts the legacy pre-streaming envelope during rollout', () => {
    // A not-yet-redeployed rayfin_kusto_v1 returns { status, output, errors }
    // with output.tables already in connector shape. Without dual-accept this
    // would read as no Tables and silently empty the result.
    const legacy = {
      status: 'Succeeded',
      output: {
        tables: [
          {
            name: 'Table_0',
            columns: [{ name: 'State', type: 'string' }],
            rows: [['WA'], ['OR']],
          },
        ],
        clientRequestId: 'KPC.rayfin_kusto_v1;legacy-1',
      },
      errors: [],
    } as unknown as KustoQueryResponse;

    const result = toQueryResult(legacy);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0]?.rows).toEqual([['WA'], ['OR']]);
      // The envelope's own correlation id is used when the caller omits one.
      expect(result.clientRequestId).toBe('KPC.rayfin_kusto_v1;legacy-1');
    }
  });

  it('surfaces a legacy envelope error when it carries no tables', () => {
    const legacy = {
      status: 'Failed',
      output: { tables: [] },
      errors: [{ message: 'Request is invalid', code: 'BadRequest' }],
    } as unknown as KustoQueryResponse;

    const result = toQueryResult(legacy);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.message).toBe('Request is invalid');
      expect(result.error.code).toBe('BadRequest');
    }
  });

  it('keeps a legacy envelope error authoritative even with partial tables', () => {
    // Regression: the pre-streaming implementation returned an error whenever
    // `errors` was non-empty, without consulting `output.tables`. A partial
    // result carried alongside a connector error must not degrade to success.
    const legacy = {
      status: 'Failed',
      output: {
        tables: [
          {
            name: 'PrimaryResult',
            columns: [{ name: 'State', type: 'string' }],
            rows: [['TEXAS']],
          },
        ],
      },
      errors: [{ message: 'Partial query failure', code: 'LimitsExceeded' }],
    } as unknown as KustoQueryResponse;

    const result = toQueryResult(legacy);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.message).toBe('Partial query failure');
      expect(result.error.code).toBe('LimitsExceeded');
    }
  });

  it('keeps a native trailing warning non-fatal when a data table is present', () => {
    // Counterpart to the legacy rule: on the native path a trailing row-level
    // warning rides alongside a valid QueryResult table, so it must not turn a
    // successful query into an error.
    const native = {
      Tables: [
        {
          TableName: 'Table_0',
          Columns: [{ ColumnName: 'State', ColumnType: 'string' }],
          Rows: [['TEXAS'], { Exceptions: ['soft warning'] }],
        },
      ],
    } as unknown as KustoQueryResponse;

    const result = toQueryResult(native);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.tables[0]!.rows).toEqual([['TEXAS']]);
    }
  });

  it('lets an explicit correlation id override a legacy envelope id', () => {
    const legacy = {
      status: 'Succeeded',
      output: {
        tables: [
          {
            name: 'Table_0',
            columns: [{ name: 'X', type: 'long' }],
            rows: [[1]],
          },
        ],
        clientRequestId: 'KPC.rayfin_kusto_v1;legacy-2',
      },
      errors: [],
    } as unknown as KustoQueryResponse;

    const result = toQueryResult(legacy, {
      clientRequestId: 'KPC.rayfin_kusto_v1;caller',
    });
    expect(result.clientRequestId).toBe('KPC.rayfin_kusto_v1;caller');
  });

  it('preserves nulls and Kusto scalar types', () => {
    const result = toQueryResult({
      Tables: [
        {
          TableName: 'Table_0',
          Columns: [
            { ColumnName: 'Count', ColumnType: 'long' },
            { ColumnName: 'ObservedAt', ColumnType: 'datetime' },
            { ColumnName: 'Payload', ColumnType: 'dynamic' },
            { ColumnName: 'TenantId', ColumnType: 'guid' },
          ],
          Rows: [
            [
              3,
              '2026-07-15T08:00:00Z',
              { healthy: true },
              '58c2cfb8-66bd-4f25-bf90-ae08feee6c06',
            ],
            [0, null, null, null],
          ],
        },
      ],
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.tables[0]?.columns.map((column) => column.type)).toEqual([
        'long',
        'datetime',
        'dynamic',
        'guid',
      ]);
      expect(result.tables[0]?.rows[1]).toEqual([0, null, null, null]);
    }
  });

  it('defensively normalizes malformed columns and short rows', () => {
    const result = toQueryResult({
      Tables: [
        {
          // TableName missing -> name ''.
          Columns: [
            { ColumnName: 'Valid', ColumnType: 'decimal' },
            { ColumnName: 'UnknownType' }, // no type -> 'unknown'
            { ColumnType: 'string' }, // no ColumnName -> dropped
          ],
          Rows: [[1], 'not-a-row', [2, undefined, 'extra']],
        },
      ],
    });

    expect(result).toEqual({
      status: 'success',
      clientRequestId: '',
      tables: [
        {
          name: '',
          columns: [
            { name: 'Valid', type: 'decimal' },
            { name: 'UnknownType', type: 'unknown' },
          ],
          rows: [
            [1, null],
            [2, null],
          ],
        },
      ],
    });
  });
});

describe('splitV1Rows', () => {
  it('leaves rows untouched when the last row is an array', () => {
    expect(splitV1Rows([[1], [2]])).toEqual({ rows: [[1], [2]], errors: [] });
  });

  it('strips a trailing OneApiErrors object', () => {
    expect(splitV1Rows([[1], { OneApiErrors: [{ error: 'x' }] }])).toEqual({
      rows: [[1]],
      errors: [{ error: 'x' }],
    });
  });
});
