import type {
  KustoColumn,
  KustoQueryResponse,
  KustoTable,
  KustoV1Table,
} from './types';

/**
 * Error returned by {@link toQueryResult}.
 */
export interface KustoQueryError {
  /** Human-readable error message. */
  message: string;
  /** Connector or service error code, when available. */
  code?: string;
}

/**
 * Correlation ids the SDK knows out-of-band.
 *
 * They are deliberately **not** part of the streamed response body: the
 * connector function relays the Kusto bytes untouched. `clientRequestId` is the
 * value the SDK generated and the function forwarded as `x-ms-client-request-id`;
 * `activityId` is header-sourced or lost. Pass whatever is known; both default
 * to empty (mirroring the semantic-model delegated path).
 */
export interface KustoCorrelation {
  clientRequestId?: string;
  activityId?: string;
}

/**
 * Normalized Kusto query result.
 *
 * Successful results preserve every returned table.
 * Failed results expose only the generic error rather than success-shaped
 * query fields.
 */
export type KustoQueryResult =
  | {
      status: 'success';
      tables: KustoTable[];
      clientRequestId: string;
      activityId?: string;
    }
  | {
      status: 'error';
      error: KustoQueryError;
      clientRequestId: string;
      activityId?: string;
    };

/**
 * Loose intermediate table shape produced by {@link transformV1} before the
 * `normalizeTable` defenses run. Columns keep their raw (possibly missing) name
 * and type so `normalizeColumn` can still drop malformed entries.
 */
interface LooseTable {
  name?: unknown;
  columns: { name?: unknown; type?: unknown }[];
  rows: unknown[];
}

/**
 * Split a Kusto v1 table's rows. A `QueryResult` table may append a trailing
 * non-array error object after its data rows; strip it and surface its
 * exceptions. Mirrors Kusto Web Explorer's `splitV1Rows`.
 */
export function splitV1Rows(rows: unknown[]): {
  rows: unknown[];
  errors: unknown[];
} {
  if (rows.length > 0 && !Array.isArray(rows[rows.length - 1])) {
    const last = rows[rows.length - 1];
    let errors: unknown[] = [];
    if (isRecord(last)) {
      const raw = last.Exceptions ?? last.OneApiErrors;
      if (Array.isArray(raw)) {
        errors = raw;
      }
    }
    return { rows: rows.slice(0, -1), errors };
  }
  return { rows, errors: [] };
}

/**
 * Map a Kusto v1 table
 * `{ TableName, Columns: [{ ColumnName, ColumnType | DataType }], Rows }`
 * to the loose connector shape `{ name, columns: [{ name, type }], rows }`.
 * The `normalizeTable` defenses run afterwards.
 */
function mapTable(table: KustoV1Table): {
  table: LooseTable;
  errors: unknown[];
} {
  const { rows, errors } = splitV1Rows(
    Array.isArray(table.Rows) ? table.Rows : []
  );
  const columns = (Array.isArray(table.Columns) ? table.Columns : []).map(
    (column) => ({
      name: isRecord(column) ? column.ColumnName : undefined,
      type: isRecord(column)
        ? (column.ColumnType ?? column.DataType)
        : undefined,
    })
  );
  return { table: { name: table.TableName, columns, rows }, errors };
}

/**
 * Transform a raw Kusto v1 document into connector-shaped tables plus any
 * trailing row errors.
 *
 * A single-table response maps directly. A multi-table response uses the last
 * table as a Table of Contents: find the `Kind`, `Name`, and `PrettyName` column
 * indices, keep only tables whose `Kind == "QueryResult"`, and rename each by its
 * logical name. The standard Kusto v1 ToC carries the logical name (for example
 * `PrimaryResult`) in the `Name` column and commonly leaves `PrettyName` empty,
 * so prefer `PrettyName` when present and fall back to `Name`; only when both are
 * empty is the transport name (`Table_0`) kept. This is the SDK-side port of the
 * connector function's former `_transform_v1`, moved here so the function can
 * relay Kusto bytes untouched (matching how `rayfin_semantic_model_v1` leaves
 * Arrow parsing to the SDK).
 */
export function transformV1(response: KustoQueryResponse): {
  tables: LooseTable[];
  errors: unknown[];
} {
  const tables = Array.isArray(response.Tables) ? response.Tables : [];
  const out: LooseTable[] = [];
  const errors: unknown[] = [];

  if (tables.length === 0) {
    return { tables: out, errors };
  }
  if (tables.length === 1) {
    const mapped = mapTable(tables[0]!);
    out.push(mapped.table);
    errors.push(...mapped.errors);
    return { tables: out, errors };
  }

  const toc: KustoV1Table = tables[tables.length - 1] ?? {};
  const tocColumns = Array.isArray(toc.Columns) ? toc.Columns : [];
  const kindIdx = tocColumns.findIndex(
    (column) => isRecord(column) && column.ColumnName === 'Kind'
  );
  const nameIdx = tocColumns.findIndex(
    (column) => isRecord(column) && column.ColumnName === 'Name'
  );
  const prettyIdx = tocColumns.findIndex(
    (column) => isRecord(column) && column.ColumnName === 'PrettyName'
  );
  const tocRows = Array.isArray(toc.Rows) ? toc.Rows : [];

  tocRows.forEach((row, index) => {
    if (!Array.isArray(row) || index >= tables.length) {
      return;
    }
    const kind =
      kindIdx >= 0 && kindIdx < row.length ? row[kindIdx] : undefined;
    if (kind !== 'QueryResult') {
      return;
    }
    const mapped = mapTable(tables[index]!);
    // Prefer PrettyName; the standard ToC leaves it empty and carries the
    // logical name in Name, so fall back to Name before the transport name.
    const pretty =
      prettyIdx >= 0 && prettyIdx < row.length ? row[prettyIdx] : undefined;
    const logical =
      nameIdx >= 0 && nameIdx < row.length ? row[nameIdx] : undefined;
    const resultName =
      typeof pretty === 'string' && pretty
        ? pretty
        : typeof logical === 'string' && logical
          ? logical
          : undefined;
    if (resultName) {
      mapped.table.name = resultName;
    }
    out.push(mapped.table);
    errors.push(...mapped.errors);
  });

  return { tables: out, errors };
}

/**
 * Normalize a Kusto response document into a discriminated result.
 *
 * The connector function streams the Kusto v1 body untouched, so the
 * steady-state input is the raw `{ Tables }` document: this runs the ported
 * `transformV1` and then the same defensive normalization as before — it
 * preserves JSON-native column types and row values, pads short rows with
 * `null`, ignores malformed columns and rows, and treats a missing table
 * collection as an empty successful result. On this native path a row-level
 * error is surfaced only when the transform yields no data table (a
 * `QueryResult` table may carry a trailing soft warning alongside a valid result
 * set). `toError` is unchanged.
 *
 * **Rollout compatibility.** The SDK package and the connector function ship
 * from separate repositories and cannot deploy atomically, so this also accepts
 * the pre-streaming envelope `{ status, output: { tables }, errors }` that a
 * not-yet-redeployed `rayfin_kusto_v1` still returns. Without that, the raw
 * reader would find no `Tables`, yield zero rows, and silently report success —
 * emptying every query during the mixed-version window. On that path a
 * non-empty `errors` is authoritative even when `output.tables` is populated,
 * matching the pre-streaming implementation, so a partial result carried
 * alongside a connector error is never reported as success. See
 * `readLegacyEnvelope`.
 *
 * @param response - Raw Kusto v1 document relayed by `executeQuery`, or the
 *   transitional pre-streaming envelope.
 * @param correlation - Correlation ids the SDK knows out-of-band; never on the
 *   wire. Both default to empty. When omitted, ids carried by a legacy envelope
 *   are used as a fallback.
 */
export function toQueryResult(
  response: KustoQueryResponse,
  correlation: KustoCorrelation = {}
): KustoQueryResult {
  const legacy = readLegacyEnvelope(response);
  const native = legacy ? undefined : transformV1(response);
  const rawTables = legacy ? legacy.tables : native!.tables;
  const errors = legacy ? legacy.errors : native!.errors;

  const clientRequestId =
    typeof correlation.clientRequestId === 'string' &&
    correlation.clientRequestId
      ? correlation.clientRequestId
      : (legacy?.clientRequestId ?? '');
  const activityId =
    typeof correlation.activityId === 'string' && correlation.activityId
      ? correlation.activityId
      : legacy?.activityId;
  const correlated = {
    clientRequestId,
    ...(activityId !== undefined ? { activityId } : {}),
  };

  const tables = rawTables
    .map(normalizeTable)
    .filter((table): table is KustoTable => table !== undefined);

  // Legacy-envelope errors stay authoritative: the pre-streaming implementation
  // returned an error whenever `errors` was non-empty, without consulting
  // `output.tables`, so a partial result carried alongside a function/connector
  // error must not degrade to success. On the native path an `errors` entry is a
  // trailing row-level warning that a valid `QueryResult` table may carry, so it
  // is surfaced only when the transform produced no data table.
  if (errors.length > 0 && (legacy !== undefined || tables.length === 0)) {
    return {
      status: 'error',
      error: toError(errors[0]),
      ...correlated,
    };
  }

  return {
    status: 'success',
    tables,
    ...correlated,
  };
}

/**
 * Transitional shape of the pre-streaming connector envelope, kept internal so
 * the public {@link KustoQueryResponse} stays the native `{ Tables }` document.
 */
interface LegacyEnvelope {
  tables: unknown[];
  errors: unknown[];
  clientRequestId?: string;
  activityId?: string;
}

/**
 * Detect and read the pre-streaming envelope
 * `{ status, output: { tables, clientRequestId?, activityId? }, errors }` a
 * not-yet-redeployed `rayfin_kusto_v1` still returns. Its `output.tables` are
 * already in the connector `{ name, columns, rows }` shape, so they feed
 * straight into {@link normalizeTable}. Returns `undefined` for the native
 * `{ Tables }` document (the steady-state path), which is detected first so a
 * genuine Kusto response is never misread as an envelope.
 */
function readLegacyEnvelope(
  response: KustoQueryResponse
): LegacyEnvelope | undefined {
  const record = response as Record<string, unknown>;
  // The native Kusto v1 document always carries `Tables`; the legacy envelope
  // never does. Prefer the native path whenever `Tables` is present.
  if ('Tables' in record) {
    return undefined;
  }
  const output = isRecord(record.output) ? record.output : undefined;
  // Only treat this as the envelope when an envelope marker is present, so an
  // arbitrary `{}` still normalizes to an empty successful result as before.
  if (output === undefined && !('status' in record) && !('errors' in record)) {
    return undefined;
  }
  const tables = output && Array.isArray(output.tables) ? output.tables : [];
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const clientRequestId =
    output && typeof output.clientRequestId === 'string'
      ? output.clientRequestId
      : undefined;
  const activityId =
    output && typeof output.activityId === 'string'
      ? output.activityId
      : undefined;
  return {
    tables,
    errors,
    ...(clientRequestId !== undefined ? { clientRequestId } : {}),
    ...(activityId !== undefined ? { activityId } : {}),
  };
}

function normalizeTable(value: unknown): KustoTable | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const columns = Array.isArray(value.columns)
    ? value.columns
        .map(normalizeColumn)
        .filter((column) => column !== undefined)
    : [];
  const rows = Array.isArray(value.rows)
    ? value.rows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) =>
          columns.length > 0
            ? columns.map((_, index) => row[index] ?? null)
            : [...row]
        )
    : [];

  return {
    name: typeof value.name === 'string' ? value.name : '',
    columns,
    rows,
  };
}

function normalizeColumn(value: unknown): KustoColumn | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return undefined;
  }

  return {
    name: value.name,
    type: typeof value.type === 'string' ? value.type : 'unknown',
  };
}

function toError(value: unknown): KustoQueryError {
  if (typeof value === 'string') {
    return { message: value };
  }

  if (!isRecord(value)) {
    return { message: 'Connector returned an error.' };
  }

  const rawMessage =
    typeof value.message === 'string'
      ? value.message
      : 'Connector returned an error.';
  const parsed = tryParseRecord(rawMessage);
  const message =
    typeof parsed?.message === 'string' ? parsed.message : rawMessage;
  const code =
    typeof parsed?.code === 'string'
      ? parsed.code
      : typeof value.code === 'string'
        ? value.code
        : undefined;

  return {
    message,
    ...(code !== undefined ? { code } : {}),
  };
}

function tryParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
