/**
 * Tests for {@link parseArrowStream}, the Apache Arrow IPC decoder for the
 * `fabric-semanticmodel` connector.
 *
 * Fixtures are produced with apache-arrow's own `tableToIPC(..., 'stream')`
 * so the decoder is exercised against real Arrow IPC bytes rather than a
 * hand-rolled mock.
 */

import {
  Bool,
  DateDay,
  DateMillisecond,
  Decimal,
  DenseUnion,
  Dictionary,
  Field,
  Float64,
  Int8,
  Int64,
  makeData,
  makeVector,
  Table,
  TimestampMillisecond,
  tableFromArrays,
  tableFromIPC,
  tableToIPC,
  Utf8,
  Vector,
  vectorFromArray,
} from 'apache-arrow';
import { describe, it, expect } from 'vitest';

import { ArrowOverflowError, parseArrowStream } from '../arrow';
import { toQueryResult } from '../queryResult';

import {
  captureBytes,
  POWER_BI_VARIANT_CURRENCY_STRING_DATE,
  POWER_BI_VARIANT_INT_STRING,
} from './powerBiCaptures';

/** Encode a set of named columns as an Arrow IPC stream `Uint8Array`. */
function arrowStream(columns: Record<string, unknown[]>): Uint8Array {
  const table = tableFromArrays(columns as Record<string, ArrayLike<unknown>>);
  return tableToIPC(table, 'stream');
}

/**
 * Encode explicitly-typed Arrow vectors as an IPC stream. Used for types that
 * `tableFromArrays` cannot infer from plain JS arrays (Decimal, Date,
 * Timestamp), so the coercion paths run against real Arrow IPC bytes.
 */
function typedArrowStream(columns: Record<string, Vector>): Uint8Array {
  return tableToIPC(new Table(columns), 'stream');
}

/** Build a single-row Decimal128 column from a little-endian mantissa. */
function decimalColumn(mantissa: number[], scale: number): Vector {
  return makeVector(
    makeData({
      type: new Decimal(scale, 38, 128),
      data: new Uint32Array(mantissa),
      length: 1,
    })
  );
}

/** Build a dense Union column from explicitly tagged child vectors. */
function denseUnionColumn(
  children: Array<{ field: Field; vector: Vector }>,
  typeIds: number[],
  valueOffsets: number[]
): Vector {
  const type = new DenseUnion(
    children.map((_, index) => index),
    children.map(({ field }) => field)
  );
  return makeVector(
    makeData({
      type,
      length: typeIds.length,
      typeIds: new Int8Array(typeIds),
      valueOffsets: new Int32Array(valueOffsets),
      children: children.map(({ vector }) => vector.data[0]),
    })
  );
}

/**
 * One dictionary entry of a Power BI Variant column, keyed by the Union child
 * that holds it. `currency` is the unscaled Decimal(19, 4) mantissa.
 */
type VariantEntry =
  | { int64: bigint }
  | { currency: number }
  | { bool: boolean }
  | { date: Date }
  | { double: number }
  | { string: string };

/** The Union children Power BI uses for Variant columns, in wire order. */
const VARIANT_CHILDREN = [
  new Field('int64', new Int64(), true),
  new Field('currency', new Decimal(4, 19, 128), true),
  new Field('bool', new Bool(), true),
  new Field('date', new DateMillisecond(), true),
  new Field('double', new Float64(), true),
  new Field('string', new Utf8(), true),
];

/** Build a Decimal child from non-negative mantissas below 2^32. */
function decimalChildData(type: Decimal, mantissas: number[]) {
  return makeData({
    type,
    length: mantissas.length,
    data: new Uint32Array(mantissas.flatMap((m) => [m, 0, 0, 0])),
  });
}

/**
 * Build the dense Union (Int64, Decimal(19, 4), Bool, Date64, Float64, Utf8)
 * that Power BI uses for Variant values, one row per entry.
 */
function variantUnion(entries: VariantEntry[]): Vector {
  const buckets: unknown[][] = VARIANT_CHILDREN.map(() => []);
  const typeIds: number[] = [];
  const valueOffsets: number[] = [];
  for (const entry of entries) {
    const [name, value] = Object.entries(entry)[0];
    const childIndex = VARIANT_CHILDREN.findIndex((f) => f.name === name);
    typeIds.push(childIndex);
    valueOffsets.push(buckets[childIndex].length);
    buckets[childIndex].push(value);
  }
  const children = VARIANT_CHILDREN.map(({ type }, index) =>
    type instanceof Decimal
      ? decimalChildData(type, buckets[index] as number[])
      : vectorFromArray(buckets[index], type).data[0]
  );
  return makeVector(
    makeData({
      type: new DenseUnion(
        VARIANT_CHILDREN.map((_, index) => index),
        VARIANT_CHILDREN
      ),
      length: entries.length,
      typeIds: new Int8Array(typeIds),
      valueOffsets: new Int32Array(valueOffsets),
      children,
    })
  );
}

/**
 * Build one chunk of a `Dictionary<Int8, Union<...>>` column, mirroring how
 * Power BI encodes Variant columns. A `null` key marks a null row.
 */
function variantChunk(dictionary: Vector, keys: Array<number | null>) {
  const nullBitmap = new Uint8Array(Math.ceil(keys.length / 8));
  keys.forEach((key, index) => {
    if (key !== null) nullBitmap[index >> 3] |= 1 << (index & 7);
  });
  return makeData({
    type: new Dictionary(dictionary.type, new Int8(), 0),
    length: keys.length,
    nullCount: keys.filter((key) => key === null).length,
    nullBitmap,
    data: Int8Array.from(keys, (key) => key ?? 0),
    dictionary,
  });
}

/** Build a single-chunk dictionary-encoded Variant column. */
function variantColumn(dictionary: Vector, keys: Array<number | null>): Vector {
  return makeVector(variantChunk(dictionary, keys));
}

/** Decode a single-column result and return that column's values. */
function decodeColumn(bytes: Uint8Array, name: string): unknown[] {
  const response = parseArrowStream(bytes);
  return response.output.tables[0].rows.map((row) => row[name]);
}

describe('parseArrowStream', () => {
  it('decodes a success table into the tabular wire shape', () => {
    const bytes = arrowStream({
      'Sales[Region]': ['North', 'South'],
      'Sales[Units]': [10, 20],
    });

    const response = parseArrowStream(bytes, 'req-1');

    expect(response.status).toBe('Succeeded');
    expect(response.errors).toEqual([]);
    expect(response.output.requestId).toBe('req-1');
    expect(response.output.queryError).toBeUndefined();

    const table = response.output.tables[0];
    expect(table.rows).toEqual([
      { 'Sales[Region]': 'North', 'Sales[Units]': 10 },
      { 'Sales[Region]': 'South', 'Sales[Units]': 20 },
    ]);
    expect(table.columns).toEqual([
      { name: 'Sales[Region]', dataType: 'String' },
      { name: 'Sales[Units]', dataType: 'Double' },
    ]);
  });

  it('narrows in-range Int64 (bigint) values to numbers', () => {
    const bytes = arrowStream({
      Count: [BigInt(1), BigInt(42)],
    });

    const response = parseArrowStream(bytes);

    expect(response.output.tables[0].rows).toEqual([
      { Count: 1 },
      { Count: 42 },
    ]);
    expect(response.output.tables[0].columns).toEqual([
      { name: 'Count', dataType: 'Int64' },
    ]);
  });

  it('narrows active Int64 values inside a Union while preserving other children', () => {
    const bytes = typedArrowStream({
      Mixed: denseUnionColumn(
        [
          {
            field: new Field('integer', new Int64(), true),
            vector: vectorFromArray([BigInt(836432), BigInt(42)], new Int64()),
          },
          {
            field: new Field('string', new Utf8(), true),
            vector: vectorFromArray(['label'], new Utf8()),
          },
        ],
        [0, 1, 0],
        [0, 0, 1]
      ),
    });

    const response = parseArrowStream(bytes);

    expect(response.output.tables[0].rows).toEqual([
      { Mixed: 836432 },
      { Mixed: 'label' },
      { Mixed: 42 },
    ]);
  });

  it('surfaces active Int64 overflow inside a Union as a per-table error', () => {
    const overflow = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
    const bytes = typedArrowStream({
      Mixed: denseUnionColumn(
        [
          {
            field: new Field('integer', new Int64(), true),
            vector: vectorFromArray([overflow], new Int64()),
          },
        ],
        [0],
        [0]
      ),
    });

    const response = parseArrowStream(bytes);

    const table = response.output.tables[0];
    expect(table.rows).toEqual([]);
    expect(table.error?.message).toContain('MAX_SAFE_INTEGER');
  });

  it('applies Decimal and Timestamp coercion to active Union children', () => {
    const decimalType = new Decimal(2, 38, 128);
    const timestampType = new TimestampMillisecond();
    const bytes = typedArrowStream({
      Mixed: denseUnionColumn(
        [
          {
            field: new Field('decimal', decimalType, true),
            vector: decimalColumn([12345, 0, 0, 0], 2),
          },
          {
            field: new Field('timestamp', timestampType, true),
            vector: vectorFromArray(
              [new Date('2022-06-01T12:34:56Z')],
              timestampType
            ),
          },
        ],
        [0, 1],
        [0, 0]
      ),
    });

    const response = parseArrowStream(bytes);

    expect(response.output.tables[0].rows).toEqual([
      { Mixed: 123.45 },
      { Mixed: '2022-06-01T12:34:56.000' },
    ]);
  });

  it('maps a DAX error table to output.queryError', () => {
    const bytes = arrowStream({
      ErrorCode: ['DAX_ERROR'],
      ErrorMessage: ['Column not found'],
      ErrorDescription: ['The column Foo does not exist'],
    });

    const response = parseArrowStream(bytes, 'req-err');

    expect(response.output.tables).toEqual([]);
    expect(response.output.requestId).toBe('req-err');
    expect(response.output.queryError).toEqual({
      message: 'Column not found',
      code: 'DAX_ERROR',
      details: 'The column Foo does not exist',
    });
    expect(toQueryResult(response)).toEqual({
      status: 'error',
      requestId: 'req-err',
      error: {
        category: 'query',
        message: 'Column not found',
        code: 'DAX_ERROR',
        details: 'The column Foo does not exist',
      },
    });
  });

  it('omits null optional DAX diagnostics', () => {
    const response = parseArrowStream(
      arrowStream({
        ErrorCode: [null],
        ErrorMessage: [null],
        ErrorDescription: [null],
      })
    );

    expect(response.output.queryError).toEqual({
      message: 'Unknown DAX error',
    });
    expect(toQueryResult(response)).toEqual({
      status: 'error',
      requestId: '',
      error: { category: 'query', message: 'Unknown DAX error' },
    });
  });

  it('keeps the fallback message when an error table has no rows', () => {
    const response = parseArrowStream(
      arrowStream({ ErrorCode: [], ErrorMessage: [], ErrorDescription: [] })
    );

    expect(response.output.queryError).toEqual({
      message: 'Unknown DAX error',
    });
  });

  it.each([
    { code: 0, message: 42, details: false },
    { code: BigInt(123), message: true, details: BigInt(456) },
  ])(
    'stringifies present DAX diagnostics: %#',
    ({ code, message, details }) => {
      const response = parseArrowStream(
        arrowStream({
          ErrorCode: [code],
          ErrorMessage: [message],
          ErrorDescription: [details],
        })
      );

      expect(toQueryResult(response)).toEqual({
        status: 'error',
        requestId: '',
        error: {
          category: 'query',
          message: String(message),
          code: String(code),
          details: String(details),
        },
      });
    }
  );

  it('drops empty-string DAX diagnostics and falls back to a message', () => {
    const response = parseArrowStream(
      arrowStream({
        ErrorCode: [''],
        ErrorMessage: [''],
        ErrorDescription: [''],
      })
    );

    // Empty diagnostics are omitted rather than surfaced as `code: ''` /
    // `details: ''`, and an empty message falls back to the generic text.
    expect(response.output.queryError).toEqual({
      message: 'Unknown DAX error',
    });
    expect(toQueryResult(response)).toEqual({
      status: 'error',
      requestId: '',
      error: { category: 'query', message: 'Unknown DAX error' },
    });
  });

  it('still strips engine markup during normalization without losing diagnostics', () => {
    const response = parseArrowStream(
      arrowStream({
        ErrorCode: ['DAX_ERROR'],
        ErrorMessage: ["Column '<ccon>Foo</ccon>' not found"],
        ErrorDescription: ['Check <pii>Foo</pii><crlf>in the model'],
      })
    );

    expect(response.output.queryError?.details).toBe(
      'Check <pii>Foo</pii><crlf>in the model'
    );
    expect(toQueryResult(response)).toEqual({
      status: 'error',
      requestId: '',
      error: {
        category: 'query',
        code: 'DAX_ERROR',
        message: "Column 'Foo' not found",
        details: 'Check Foo\nin the model',
      },
    });
  });

  it('does not classify a table missing an error marker column as an error', () => {
    const response = parseArrowStream(
      arrowStream({ ErrorCode: ['value'], ErrorMessage: ['data'] })
    );

    expect(response.output.queryError).toBeUndefined();
    expect(response.output.tables[0].rows).toEqual([
      { ErrorCode: 'value', ErrorMessage: 'data' },
    ]);
    expect(toQueryResult(response).status).toBe('success');
  });

  it('surfaces Int64 overflow as a per-table error', () => {
    const overflow = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(10);
    const bytes = arrowStream({
      BigValue: [overflow],
    });

    const response = parseArrowStream(bytes);

    const table = response.output.tables[0];
    expect(table.rows).toEqual([]);
    expect(table.error).toBeDefined();
    expect(table.error?.message).toContain('MAX_SAFE_INTEGER');
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const bytes = arrowStream({ Name: ['a'] });
    const copy = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );

    const response = parseArrowStream(copy);

    expect(response.output.tables[0].rows).toEqual([{ Name: 'a' }]);
  });

  it('scales an in-range Decimal mantissa by 10^scale', () => {
    // Mantissa 12345 at scale 2 => 123.45.
    const bytes = typedArrowStream({
      Amount: decimalColumn([12345, 0, 0, 0], 2),
    });

    const response = parseArrowStream(bytes);

    expect(response.output.tables[0].rows).toEqual([{ Amount: 123.45 }]);
    expect(response.output.tables[0].columns).toEqual([
      { name: 'Amount', dataType: 'Decimal' },
    ]);
  });

  it('surfaces an out-of-range Decimal as a per-table overflow error', () => {
    // Mantissa 2^64 - 1 (~1.8e19) is far beyond Number.MAX_SAFE_INTEGER.
    const bytes = typedArrowStream({
      Amount: decimalColumn([0xffffffff, 0xffffffff, 0, 0], 0),
    });

    const response = parseArrowStream(bytes);

    const table = response.output.tables[0];
    expect(table.rows).toEqual([]);
    expect(table.error?.message).toContain('MAX_SAFE_INTEGER');
  });

  it('formats a DateDay as a timezone-unaware ISO string', () => {
    const bytes = typedArrowStream({
      When: vectorFromArray([new Date('2022-06-01T00:00:00Z')], new DateDay()),
    });

    const response = parseArrowStream(bytes);

    expect(response.output.tables[0].rows).toEqual([
      { When: '2022-06-01T00:00:00.000' },
    ]);
    expect(response.output.tables[0].columns).toEqual([
      { name: 'When', dataType: 'DateTime' },
    ]);
  });

  it('formats a Timestamp as a timezone-unaware ISO string', () => {
    const bytes = typedArrowStream({
      At: vectorFromArray(
        [new Date('2022-06-01T12:34:56Z')],
        new TimestampMillisecond()
      ),
    });

    const response = parseArrowStream(bytes);

    expect(response.output.tables[0].rows).toEqual([
      { At: '2022-06-01T12:34:56.000' },
    ]);
    expect(response.output.tables[0].columns).toEqual([
      { name: 'At', dataType: 'DateTime' },
    ]);
  });

  it('decodes an empty body to an empty successful response', () => {
    const response = parseArrowStream(new Uint8Array(0), 'req-empty');

    expect(response.status).toBe('Succeeded');
    expect(response.output.tables).toEqual([]);
    expect(response.output.requestId).toBe('req-empty');
    expect(response.errors).toEqual([]);
  });
});

describe('parseArrowStream: Power BI Variant (dictionary-encoded Union) columns', () => {
  it('decodes an Int64 and a string sharing one Variant column', () => {
    const bytes = typedArrowStream({
      m: variantColumn(
        variantUnion([{ int64: BigInt(5) }, { string: 'text' }]),
        [0, 1]
      ),
    });

    expect(decodeColumn(bytes, 'm')).toEqual([5, 'text']);
  });

  it('scales Decimal and formats Date64 values alongside strings', () => {
    const bytes = typedArrowStream({
      m: variantColumn(
        variantUnion([
          { currency: 123400 },
          { string: 'text' },
          { date: new Date('2024-01-31T00:00:00Z') },
        ]),
        [0, 1, 2]
      ),
    });

    expect(decodeColumn(bytes, 'm')).toEqual([
      12.34,
      'text',
      '2024-01-31T00:00:00.000',
    ]);
  });

  it('coerces all-numeric Variant values (Int64, Decimal, Float64)', () => {
    const bytes = typedArrowStream({
      m: variantColumn(
        variantUnion([
          { int64: BigInt(0) },
          { currency: 0 },
          { int64: BigInt(836432) },
          { currency: 12345678 },
          { double: 2.5 },
        ]),
        [0, 1, 2, 3, 4]
      ),
    });

    const values = decodeColumn(bytes, 'm');
    expect(values).toEqual([0, 0, 836432, 1234.5678, 2.5]);
    expect(values.every((value) => typeof value === 'number')).toBe(true);
  });

  it('passes Bool Variant values through unchanged', () => {
    const bytes = typedArrowStream({
      m: variantColumn(variantUnion([{ bool: true }, { bool: false }]), [0, 1]),
    });

    expect(decodeColumn(bytes, 'm')).toEqual([true, false]);
  });

  it('returns null for null dictionary keys', () => {
    const bytes = typedArrowStream({
      m: variantColumn(
        variantUnion([{ int64: BigInt(5) }, { currency: 123400 }]),
        [0, null, 1, null]
      ),
    });

    expect(decodeColumn(bytes, 'm')).toEqual([5, null, 12.34, null]);
  });

  it('coerces every row that shares a dictionary entry', () => {
    const bytes = typedArrowStream({
      m: variantColumn(
        variantUnion([{ currency: 123400 }, { int64: BigInt(7) }]),
        [0, 1, 0, 0, 1]
      ),
    });

    expect(decodeColumn(bytes, 'm')).toEqual([12.34, 7, 12.34, 12.34, 7]);
  });

  it('resolves keys that point into a later dictionary chunk', () => {
    const dictionary = variantUnion([
      { int64: BigInt(5) },
      { string: 'a' },
    ]).concat(
      variantUnion([
        { currency: 123400 },
        { date: new Date('2024-01-31T00:00:00Z') },
      ])
    );
    const bytes = typedArrowStream({
      m: variantColumn(dictionary, [3, 0, 2, 1]),
    });

    // The writer emits the second chunk as a delta dictionary batch, so the
    // decoder sees a multi-chunk dictionary.
    const decoded = tableFromIPC(bytes).getChildAt(0);
    expect(decoded?.data[0].dictionary?.data.length).toBe(2);

    expect(decodeColumn(bytes, 'm')).toEqual([
      '2024-01-31T00:00:00.000',
      5,
      12.34,
      'a',
    ]);
  });

  it('decodes Variant columns split across record batches', () => {
    const first = variantUnion([{ int64: BigInt(5) }, { string: 'text' }]);
    const grown = first.concat(variantUnion([{ currency: 123400 }]));
    const column = makeVector([
      variantChunk(first, [0, 1]),
      variantChunk(grown, [2, 0, null, 1]),
    ]);
    const bytes = typedArrowStream({ m: column });

    expect(tableFromIPC(bytes).batches.length).toBe(2);
    expect(decodeColumn(bytes, 'm')).toEqual([
      5,
      'text',
      12.34,
      5,
      null,
      'text',
    ]);
  });

  it('surfaces Int64 overflow inside a Variant column as a per-table error', () => {
    const overflow = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
    const bytes = typedArrowStream({
      m: variantColumn(variantUnion([{ int64: overflow }]), [0]),
    });

    const table = parseArrowStream(bytes).output.tables[0];
    expect(table.rows).toEqual([]);
    expect(table.error?.message).toContain('MAX_SAFE_INTEGER');
  });

  it('still coerces a plain (non-dictionary) Variant-shaped Union', () => {
    const bytes = typedArrowStream({
      m: variantUnion([
        { int64: BigInt(5) },
        { currency: 123400 },
        { string: 'text' },
        { date: new Date('2024-01-31T00:00:00Z') },
      ]),
    });

    expect(decodeColumn(bytes, 'm')).toEqual([
      5,
      12.34,
      'text',
      '2024-01-31T00:00:00.000',
    ]);
  });

  it('decodes a captured Power BI response mixing Int64 and string', () => {
    const response = parseArrowStream(
      captureBytes(POWER_BI_VARIANT_INT_STRING),
      'req-capture'
    );

    expect(toQueryResult(response).status).toBe('success');
    expect(response.output.tables[0].rows).toEqual([
      { '[Value]': 1, '[m]': 5 },
      { '[Value]': 2, '[m]': 'text' },
    ]);
  });

  it('decodes a captured Power BI response mixing Decimal, string and date', () => {
    const response = parseArrowStream(
      captureBytes(POWER_BI_VARIANT_CURRENCY_STRING_DATE)
    );

    expect(response.output.tables[0].rows).toEqual([
      { '[Value]': 1, '[m]': 12.34 },
      { '[Value]': 2, '[m]': 'text' },
      { '[Value]': 3, '[m]': '2024-01-31T00:00:00.000' },
    ]);
  });
});

describe('ArrowOverflowError', () => {
  it('is an Error subclass with a stable name', () => {
    const error = new ArrowOverflowError('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ArrowOverflowError');
    expect(error.message).toBe('boom');
  });
});
