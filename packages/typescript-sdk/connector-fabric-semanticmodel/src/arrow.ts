/**
 * Apache Arrow IPC decoding for the `fabric-semanticmodel` connector.
 *
 * The semantic-model worker returns DAX query results as a binary Apache
 * Arrow stream (`Content-Type: application/vnd.apache.arrow.stream`). This
 * module decodes that stream into the connector's existing JSON wire shape
 * ({@link FabricSemanticModelTabularResponse}) so callers and
 * {@link toQueryResult} keep working unchanged.
 *
 * The value-coercion logic (Int64 overflow guards, decimal scaling,
 * timezone-unaware DateTime formatting, dictionary unwrapping, LZ4 frame
 * decompression) mirrors the `@microsoft/fabric-app-data` reference decoder so
 * values match the legacy JSON path exactly.
 */

import {
  tableFromIPC,
  compressionRegistry,
  CompressionType,
  Type,
  type Data,
  type Field,
  type Vector,
} from 'apache-arrow';
import { compress, decompress } from 'lz4js';

import type {
  FabricSemanticModelColumn,
  FabricSemanticModelTabularResponse,
} from './types';

// Power BI Arrow frames may be LZ4-compressed. apache-arrow ships the registry
// but not the codec, so register it once on module load.
compressionRegistry.set(CompressionType.LZ4_FRAME, {
  decode: (data) => decompress(data),
  encode: (data) => compress(data),
});

/**
 * Columns whose combined presence marks an Arrow table as a DAX error table.
 * Power BI surfaces query errors in-band (HTTP 200) as a single-row table
 * with these columns rather than as a transport error.
 */
const REQUIRED_ERROR_COLUMNS = [
  'ErrorCode',
  'ErrorMessage',
  'ErrorDescription',
];

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(-Number.MAX_SAFE_INTEGER);

/**
 * Thrown when an Arrow value cannot be represented as a JavaScript `number`
 * without losing precision (Int64 or scaled Decimal out of safe-integer
 * range). Surfaced to callers as an `'overflow'`-category query result.
 */
export class ArrowOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArrowOverflowError';
  }
}

/** Converts a single Arrow cell value into a JSON-friendly value. */
type Coercer = (
  raw: unknown,
  columnName: string,
  column?: Vector,
  rowIndex?: number
) => unknown;

/**
 * Coerce an Arrow Int64 (`bigint`) into a `number`, throwing when the value
 * cannot be represented without precision loss.
 */
function coerceBigInt(raw: unknown, columnName: string): number | null {
  if (raw === null || raw === undefined) return null;
  const v = raw as bigint;
  if (v > MAX_SAFE || v < MIN_SAFE) {
    throw new ArrowOverflowError(
      `Integer value ${v} in column "${columnName}" exceeds Number.MAX_SAFE_INTEGER and cannot be safely represented.`
    );
  }
  return Number(v);
}

/** A position within a chunked Arrow vector: the chunk and its local index. */
interface ChunkPosition {
  data: Data;
  index: number;
}

/**
 * Locate the chunk holding the logical `index` of a chunked vector, returning
 * `undefined` when the index is out of range.
 */
function locateChunk(
  chunks: readonly Data[],
  index: number
): ChunkPosition | undefined {
  let local = index;
  for (const data of chunks) {
    if (local < data.length) return { data, index: local };
    local -= data.length;
  }
  return undefined;
}

/**
 * Read the Union type id of a row, or `undefined` when the row is null or
 * cannot be resolved.
 *
 * Power BI returns Variant columns (for example most measures, or
 * `IF(cond, 5, "text")`) dictionary-encoded as `Dictionary<Int8, Union<...>>`.
 * The schema-level type is unwrapped by {@link unwrapType}, but the row-level
 * data then carries the dictionary keys in `values` and the Union itself in
 * `dictionary`, so the type id must be read from the referenced dictionary
 * entry rather than from the row data.
 */
function unionTypeIdAt(column: Vector, rowIndex: number): number | undefined {
  const row = locateChunk(column.data, rowIndex);
  if (!row || !row.data.getValid(row.index)) return undefined;

  let union = row;
  if (row.data.dictionary) {
    const key = Number(row.data.values[row.index]);
    const entry = locateChunk(row.data.dictionary.data, key);
    if (!entry || !entry.data.getValid(entry.index)) return undefined;
    union = entry;
  }

  return union.data.typeIds?.[union.index];
}

/**
 * Resolve the active child coercer for a Union row so Decimal, Date/Timestamp,
 * and Int64 values follow the same conversion paths as non-Union columns.
 * Handles both plain and dictionary-encoded Union columns.
 */
function makeUnionCoercer(field: Field): Coercer {
  const { type } = unwrapType(field);
  const childCoercers = type.children.map((child: Field) =>
    buildCoercer(child)
  );

  return function coerceUnionValue(raw, columnName, column, rowIndex) {
    if (raw === null || raw === undefined) return null;
    if (!column || rowIndex === undefined) return raw;

    const typeId = unionTypeIdAt(column, rowIndex);
    if (typeId === undefined) return raw;
    const childCoercer = childCoercers[type.typeIdToChildIndex[typeId]];
    return childCoercer ? childCoercer(raw, columnName) : raw;
  };
}

/**
 * Build a coercer for a fixed-scale Arrow Decimal: divide the integer mantissa
 * by `10^scale`, guarding against non-finite and unsafe results.
 */
function makeDecimalCoercer(scale: number): Coercer {
  const divisor = Math.pow(10, scale);
  return function coerceDecimal(raw, columnName) {
    if (raw === null || raw === undefined) return null;
    // apache-arrow returns Decimal cells as a `DecimalBigNum` (a Uint32Array
    // subclass). `Number()` yields the unscaled mantissa for in-range values,
    // but throws for magnitudes beyond Number.MAX_SAFE_INTEGER; treat that
    // throw as an overflow so it surfaces as a per-table error instead of
    // escaping the decode.
    let mantissa: number;
    try {
      mantissa = Number(raw);
    } catch {
      throw new ArrowOverflowError(
        `Decimal value in column "${columnName}" exceeds Number.MAX_SAFE_INTEGER and cannot be safely represented.`
      );
    }
    const num = mantissa / divisor;
    if (!Number.isFinite(num)) {
      throw new ArrowOverflowError(
        `Decimal value in column "${columnName}" overflows to ${num} and cannot be represented as a finite Number.`
      );
    }
    if (Math.abs(num) > Number.MAX_SAFE_INTEGER) {
      throw new ArrowOverflowError(
        `Decimal value ${num} in column "${columnName}" exceeds Number.MAX_SAFE_INTEGER and cannot be safely represented.`
      );
    }
    return num;
  };
}

/**
 * Coerce an Arrow Date/Timestamp into an ISO string *without* a trailing `Z`,
 * matching Analysis Services' timezone-unaware DateTime semantics.
 */
function coerceDateTime(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // apache-arrow normalizes Date/Timestamp cells (all units) to epoch
  // milliseconds; coerce a defensive `bigint` to a number so `new Date` never
  // throws a raw `TypeError` on it.
  const ms =
    typeof raw === 'bigint' ? Number(raw) : (raw as number | string | Date);
  return new Date(ms).toISOString().slice(0, -1);
}

/**
 * Resolve the underlying data type for a field, unwrapping dictionary-encoded
 * columns to their value type first.
 */
function unwrapType(field: Field): { typeId: number; type: any } {
  let type = field.type as any;
  if (type.typeId === Type.Dictionary) {
    type = type.dictionary;
  }
  return { typeId: type.typeId, type };
}

/** Select a value coercer for a field, or `null` to pass the value through. */
function buildCoercer(field: Field): Coercer | null {
  const { typeId, type } = unwrapType(field);
  switch (typeId) {
    case Type.Int:
      // Only 64-bit integers arrive as `bigint` and need narrowing.
      return type.bitWidth === 64 ? coerceBigInt : null;
    case Type.Decimal:
      return makeDecimalCoercer(type.scale);
    case Type.Date:
    case Type.Timestamp:
      return coerceDateTime;
    case Type.Union:
    case Type.DenseUnion:
    case Type.SparseUnion:
      return makeUnionCoercer(field);
    default:
      return null;
  }
}

/** Map an Arrow field to a Power-BI-style dataType string. */
function resolveDataType(field: Field): string {
  const { typeId, type } = unwrapType(field);
  switch (typeId) {
    case Type.Int:
      return 'Int64';
    case Type.Float:
      return 'Double';
    case Type.Decimal:
      return 'Decimal';
    case Type.Bool:
      return 'Boolean';
    case Type.Utf8:
    case Type.LargeUtf8:
      return 'String';
    case Type.Date:
    case Type.Timestamp:
      return 'DateTime';
    default:
      return String(type);
  }
}

/** A table is a DAX error table when it carries all error-marker columns. */
function isArrowErrorTable(columnNames: string[]): boolean {
  const nameSet = new Set(columnNames);
  return REQUIRED_ERROR_COLUMNS.every((col) => nameSet.has(col));
}

/**
 * Coerce a raw Arrow diagnostic cell to a string, returning `undefined` when it
 * is null/undefined or coerces to the empty string. Used for the optional
 * `code`/`details` fields so a blank `ErrorCode`/`ErrorDescription` is omitted
 * rather than surfaced as an empty diagnostic.
 */
function nonEmptyDiagnostic(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const value = String(raw);
  return value.length > 0 ? value : undefined;
}

/**
 * Decode an Apache Arrow IPC stream into a
 * {@link FabricSemanticModelTabularResponse}.
 *
 * Success rows are objects keyed by the fully-qualified column name
 * (e.g. `"Sales[Region]"`), matching the JSON wire shape so existing callers
 * and {@link toQueryResult} are unaffected. DAX error tables map to
 * `output.queryError` (categorised `'query'`), and value-overflow conditions
 * map to a per-table error (categorised `'overflow'`).
 *
 * @param bytes - The raw Arrow IPC stream bytes.
 * @param requestId - The Power BI request id, when known. Defaults to `''`.
 * @returns The decoded tabular response envelope.
 */
export function parseArrowStream(
  bytes: ArrayBuffer | Uint8Array,
  requestId = ''
): FabricSemanticModelTabularResponse {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // An empty body carries no tables; decode it to an empty (successful)
  // response rather than letting `tableFromIPC` throw on truncated input.
  if (data.byteLength === 0) {
    return {
      status: 'Succeeded',
      output: { tables: [], requestId },
      errors: [],
    };
  }
  const arrowTable = tableFromIPC(data);
  const fields = arrowTable.schema.fields;
  const columnNames = fields.map((f) => f.name);

  // DAX errors are returned in-band as a single-row error table.
  if (isArrowErrorTable(columnNames)) {
    const firstRow = arrowTable.get(0);
    const rowJson = (firstRow?.toJSON?.() ?? {}) as Record<string, unknown>;
    // `||` (not `??`) so an empty `ErrorMessage` also falls back to the generic
    // message. `code`/`details` are coerced and dropped when empty so a blank
    // diagnostic is omitted rather than rendered as `code: ''`/`details: ''`.
    const message = String(rowJson['ErrorMessage'] || 'Unknown DAX error');
    const code = nonEmptyDiagnostic(rowJson['ErrorCode']);
    const details = nonEmptyDiagnostic(rowJson['ErrorDescription']);
    return {
      status: 'Succeeded',
      output: {
        tables: [],
        requestId,
        queryError: {
          message,
          ...(code !== undefined ? { code } : {}),
          ...(details !== undefined ? { details } : {}),
        },
      },
      errors: [],
    };
  }

  const coercers = fields.map((f) => buildCoercer(f));
  const numRows = arrowTable.numRows;
  const rows: Array<Record<string, unknown>> = new Array(numRows);
  for (let r = 0; r < numRows; r++) {
    rows[r] = {};
  }

  try {
    for (let c = 0; c < fields.length; c++) {
      const col = arrowTable.getChildAt(c);
      if (!col) continue;
      const coercer = coercers[c];
      const colName = columnNames[c];
      if (coercer) {
        for (let r = 0; r < numRows; r++) {
          rows[r][colName] = coercer(col.get(r), colName, col, r);
        }
      } else {
        for (let r = 0; r < numRows; r++) {
          rows[r][colName] = col.get(r) ?? null;
        }
      }
    }
  } catch (err) {
    if (err instanceof ArrowOverflowError) {
      // Surface as a per-table error so toQueryResult categorises it 'overflow'.
      return {
        status: 'Succeeded',
        output: {
          tables: [{ rows: [], error: { message: err.message } }],
          requestId,
        },
        errors: [],
      };
    }
    throw err;
  }

  const columns: FabricSemanticModelColumn[] = fields.map((f) => ({
    name: f.name,
    dataType: resolveDataType(f),
  }));

  return {
    status: 'Succeeded',
    output: {
      tables: [{ rows, columns }],
      requestId,
    },
    errors: [],
  };
}
