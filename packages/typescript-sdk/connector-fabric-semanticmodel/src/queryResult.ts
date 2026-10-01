/**
 * Helper that normalises a {@link FabricSemanticModelTabularResponse} into
 * a UI-friendly {@link SemanticModelQueryResult}.
 *
 * The normalised shape is a discriminated union on `status`, with
 * column-aligned rows (`unknown[][]`), categorised errors, and the Power
 * BI `requestId` preserved for traceability.
 */

import type { ConnectorErrorResult } from '@microsoft/rayfin-connectors';

import type {
  FabricSemanticModelError,
  FabricSemanticModelTabularResponse,
  QueryErrorCategory,
} from './types';

export type { QueryErrorCategory } from './types';

/**
 * A single column's metadata in a normalised query result.
 */
export interface QueryColumn {
  /** Column name, e.g. `"Sales[Amount]"` or `"[Total]"`. */
  name: string;
  /**
   * Power-BI-style dataType, e.g. `"Int64"`, `"String"`, `"DateTime"`.
   *
   * Resolved from the Arrow schema when the payload carried column metadata;
   * `"unknown"` when it did not and the columns had to be inferred from the
   * first row.
   */
  dataType: string;
}

/**
 * A normalised, table-renderer-friendly query result table.
 *
 * Unlike the raw wire shape (which uses `Record<string, unknown>` rows),
 * this shape uses column-aligned `unknown[][]` rows so consumers can feed
 * them directly into data-grid components.
 */
export interface QueryTable {
  /** Column definitions in display order. */
  columns: QueryColumn[];
  /** Row-major data. Each row is an array of values aligned with `columns`. */
  rows: unknown[][];
}

/**
 * Structured error in a normalised query result.
 */
export interface QueryError {
  /** Error category. */
  category: QueryErrorCategory;
  /** Human-readable message. */
  message: string;
  /** Error code, when known. */
  code?: string;
  /**
   * Raw error detail for debugging: the verbatim response body for an API
   * failure, or structured `key=value` diagnostics for a network failure.
   */
  details?: string;
  /**
   * Remediation supplied by the producer, overriding whatever a caller would
   * otherwise derive from {@link category}. Present only where the usual
   * reading of a failure is misleading.
   */
  recoveryHint?: string;
}

/**
 * Discriminated union representing a normalised query result.
 */
export type SemanticModelQueryResult =
  | {
      status: 'success';
      table: QueryTable;
      /** Power BI `RequestId` header value, or empty string when unavailable. */
      requestId: string;
    }
  | {
      status: 'error';
      error: QueryError;
      requestId: string;
    };

/**
 * Constrain a type to the shared connector error contract, returning it
 * unchanged. Used only to make conformance a compile-time obligation.
 */
type SatisfiesConnectorErrorContract<T extends ConnectorErrorResult> = T;

/**
 * The failed arm of {@link SemanticModelQueryResult}, proved at compile time
 * to satisfy `ConnectorErrorResult`.
 *
 * The CLI reads failures through `isConnectorError` without knowing which
 * connector produced them, so widening `QueryError` in a way that breaks the
 * shared shape has to fail the build here rather than silently downgrade the
 * CLI to its generic fallback.
 */
export type SemanticModelQueryError = SatisfiesConnectorErrorContract<
  Extract<SemanticModelQueryResult, { status: 'error' }>
>;

/**
 * Narrow a value that has already been normalised.
 *
 * The wire envelope also carries a `status` (`"Succeeded"`), so the
 * discriminant alone is not safe to test. What separates the two shapes is the
 * top-level payload key: a normalised result holds `table` or `error`
 * directly, while a wire response nests everything under `output`.
 */
function isQueryResult(
  value: FabricSemanticModelTabularResponse | SemanticModelQueryResult
): value is SemanticModelQueryResult {
  const status = (value as Partial<SemanticModelQueryResult>).status;
  return (
    (status === 'success' && 'table' in value) ||
    (status === 'error' && 'error' in value)
  );
}

/**
 * Normalise a {@link FabricSemanticModelTabularResponse} into a
 * {@link SemanticModelQueryResult}.
 *
 * Error precedence (highest first):
 *
 * 1. Non-empty `response.errors[]` (FuncSet/transport failure) → `'api'`.
 * 2. `response.output.responseError` (dataset-level) → `'api'`.
 * 3. `response.output.queryError` (per-query) → `'query'`.
 * 4. `response.output.tables[0].error` (per-table) → `'overflow'`.
 *
 * Those categories are *defaults inferred from position*. When an error carries
 * an explicit {@link FabricSemanticModelError.category} it wins, which is how a
 * direct-execution failure that never reached the service is reported as
 * `'network'` rather than being mislabelled `'api'`.
 *
 * On success, column metadata is taken from `tables[0].columns` if the
 * adapter provided it; otherwise column names are inferred from
 * `Object.keys(rows[0])` and dataTypes default to `'unknown'`.
 *
 * The operation already returns a {@link SemanticModelQueryResult}, so calling
 * this is normally unnecessary. It is accepted and returned unchanged so that
 * callers written against the older contract keep working: re-normalising a
 * result would otherwise match none of the error branches and yield an empty
 * success, turning a populated table into a blank one with nothing to show for
 * it.
 */
export function toQueryResult(
  response: FabricSemanticModelTabularResponse | SemanticModelQueryResult
): SemanticModelQueryResult {
  if (isQueryResult(response)) {
    return response;
  }

  const requestId = response.output?.requestId ?? '';

  // 1. FuncSet/transport error: invocation didn't return a clean Power BI payload.
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    return {
      status: 'error',
      error: toApiError(response.errors[0]),
      requestId,
    };
  }

  // 2. Top-level response error (dataset/auth), or a direct-path failure that
  //    tagged itself with an explicit category.
  if (response.output?.responseError) {
    return {
      status: 'error',
      error: toCategorisedError(response.output.responseError, 'api'),
      requestId,
    };
  }

  // 3. Per-query error.
  if (response.output?.queryError) {
    return {
      status: 'error',
      error: toCategorisedError(response.output.queryError, 'query'),
      requestId,
    };
  }

  // 4. Per-table error → overflow (row/byte cap exceeded).
  const firstTable = response.output?.tables?.[0];
  if (firstTable?.error) {
    return {
      status: 'error',
      error: toCategorisedError(firstTable.error, 'overflow'),
      requestId,
    };
  }

  // 5. Success: build a column-aligned table.
  const rawRows = firstTable?.rows ?? [];
  const wireColumns = firstTable?.columns;
  const columns: QueryColumn[] = wireColumns
    ? wireColumns.map((c) => ({
        name: c.name,
        dataType: c.dataType ?? 'unknown',
      }))
    : (rawRows.length > 0 ? Object.keys(rawRows[0]) : []).map((name) => ({
        name,
        dataType: 'unknown',
      }));

  const rows = rawRows.map((row) =>
    columns.map((col) => row[col.name] ?? null)
  );

  return {
    status: 'success',
    table: { columns, rows },
    requestId,
  };
}

/**
 * Highlight markers the Analysis Services engine wraps around the
 * offending fragment of an error message — e.g.
 * `Failed to resolve name '<ccon>NoSuchTable</ccon>'`. They are an
 * internal formatting hint for the AS client, meaningless to our callers,
 * and leak as literal text into any UI that renders `error.message`.
 *
 * Covers the highlight family AS emits: `ccon` (constant) and
 * `pii`/`oii`/`ii` (privacy-classified identifiers). `crlf` is handled
 * separately by {@link ENGINE_LINE_BREAK_TAG} because it carries meaning.
 */
const ENGINE_MARKUP_TAG = /<\/?(?:ccon|pii|oii|ii)>/gi;

/**
 * The engine's line-break marker. Unlike the highlight markers this one is
 * not decoration — it stands in for a newline, so deleting it outright would
 * run the surrounding words together (`Model<crlf>x` → `Modelx`). Repeats
 * collapse to a single break so a stray `</crlf>` cannot double it up.
 */
const ENGINE_LINE_BREAK_TAG = /(?:<\/?crlf>)+/gi;

/**
 * Remove engine highlight markers from a user-visible message.
 *
 * Highlight markers are dropped while the text they wrap is kept, so
 * `'<ccon>Sales</ccon>'` becomes `'Sales'`. Line-break markers become real
 * newlines, preserving the layout the engine intended.
 */
export function stripEngineMarkup(value: string): string {
  return value
    .replace(ENGINE_LINE_BREAK_TAG, '\n')
    .replace(ENGINE_MARKUP_TAG, '');
}

function toCategorisedError(
  err: FabricSemanticModelError,
  fallbackCategory: QueryErrorCategory
): QueryError {
  return {
    category: err.category ?? fallbackCategory,
    message: stripEngineMarkup(err.message),
    ...(err.code !== undefined ? { code: err.code } : {}),
    ...(err.details !== undefined
      ? { details: stripEngineMarkup(err.details) }
      : {}),
    ...(err.recoveryHint !== undefined
      ? { recoveryHint: err.recoveryHint }
      : {}),
  };
}

/**
 * Convert an opaque FuncSet error entry to a {@link QueryError}.
 *
 * The FuncSet adapter emits JSON-encoded `RuntimeError` messages for
 * non-200 Power BI responses (see the Python UDF), so this helper tries
 * to parse a JSON envelope of the form
 * `{ httpStatus, code, message, requestId }` out of the entry's
 * `message` field. Falls back to the raw string when parsing fails.
 */
function toApiError(entry: unknown): QueryError {
  if (typeof entry === 'object' && entry !== null) {
    const obj = entry as Record<string, unknown>;
    const rawMessage =
      typeof obj.message === 'string' ? obj.message : undefined;
    if (rawMessage !== undefined) {
      const parsed = tryParseJson(rawMessage);
      if (parsed && typeof parsed === 'object') {
        const p = parsed as {
          httpStatus?: number;
          code?: string;
          message?: string;
        };
        const code =
          typeof p.code === 'string'
            ? p.code
            : typeof p.httpStatus === 'number'
              ? String(p.httpStatus)
              : undefined;
        return {
          category: 'api',
          message: stripEngineMarkup(
            typeof p.message === 'string' ? p.message : rawMessage
          ),
          ...(code !== undefined ? { code } : {}),
        };
      }
      return { category: 'api', message: stripEngineMarkup(rawMessage) };
    }
  }
  if (typeof entry === 'string') {
    return { category: 'api', message: stripEngineMarkup(entry) };
  }
  return { category: 'api', message: 'Connector returned an error.' };
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
