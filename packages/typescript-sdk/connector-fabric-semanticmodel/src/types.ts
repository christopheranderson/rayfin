/**
 * Runtime + type shapes for `fabric-semanticmodel`
 * operation payloads.
 */

/**
 * Input payload for the `executeQuery` operation.
 *
 * The Builder sends the DAX `query` and, optionally, per-query options such
 * as `resultSetRowCountLimit`. The connector's target
 * `workspaceId` and `itemId` are declared once under
 * `connectors.<name>.config` in `rayfin.yml`; the BaaS host injects them
 * into the request server-side from that config before forwarding to the
 * FuncSet adapter. The Builder does not (and cannot) send them on the
 * wire. The YAML is the single source of truth.
 */
export interface ExecuteQueryInput {
  /** A DAX query string. */
  query: string;
  /**
   * Cap the number of rows Analysis Services returns for this query.
   *
   * Per-call, so a caller can ask for fewer rows on one query without
   * reconfiguring the connector. Overrides the runtime option of the same
   * name when present.
   *
   * A value that is not a positive integer is dropped by this connector's
   * invoke middleware, so the rule holds for calls that run through a
   * registered {@link fabricSemanticModel} runtime, on both the CLI and the
   * delegated paths. It is not a security boundary: a client that registers no
   * runtime, or that calls `invoke()` directly, reaches the transport without
   * passing through the middleware, and nothing stops a request being made to
   * the service by other means. Rejecting an unusable limit for good is the
   * service's job.
   *
   * This is a sibling field on the request body, not a rewrite of `query`:
   * no `TOPN` is injected. When the cap truncates a result Power BI reports
   * it as a per-table error which `toQueryResult` categorises as
   * `'overflow'`, so a truncated result announces itself rather than looking
   * like a complete one.
   */
  resultSetRowCountLimit?: number;
}

/**
 * Tabular query response from the `executeQuery` operation.
 *
 * The wire envelope wraps the Power BI executeDaxQueries result with metadata
 * surfaced by the FuncSet adapter (`requestId`, structured errors).
 * `output.tables[]` is the underlying Power BI shape.
 *
 * See {@link toQueryResult} for a normalised, UI-friendly view.
 */
export interface FabricSemanticModelTabularResponse {
  /** FuncSet invocation status, e.g. `"Succeeded"`. */
  status: string;
  /** The tabular payload. */
  output: FabricSemanticModelOutput;
  /** Errors collected by FuncSet during invocation. Empty array on success. */
  errors: unknown[];
}

/**
 * Tabular payload from the connector. Mirrors the Power BI
 * `DatasetExecuteQueriesResponse` shape augmented by the FuncSet adapter.
 */
export interface FabricSemanticModelOutput {
  /** Tables returned for the query. Power BI returns exactly one table per query. */
  tables: FabricSemanticModelTable[];
  /**
   * Power BI server-assigned request id (from the `RequestId` response
   * header). Use it when reporting issues to the platform team.
   */
  requestId?: string;
  /**
   * Per-query error, for example `"More than one result table in a query"`.
   * `null` (or omitted) when the query succeeded.
   */
  queryError?: FabricSemanticModelError | null;
  /**
   * Top-level response error, for example dataset-level authorisation
   * failures. `null` (or omitted) when the response succeeded.
   */
  responseError?: FabricSemanticModelError | null;
}

/**
 * A single result table from the query.
 *
 * `columns` is populated whenever the payload was decoded from an Arrow
 * stream, which carries per-field type information. It is absent on tables
 * that have no rows to describe, such as the truncated table returned with a
 * row/byte-cap `error`.
 */
export interface FabricSemanticModelTable {
  /** Row data. Keys are fully-qualified column names, e.g. `"Sales[Amount]"`. */
  rows: Array<Record<string, unknown>>;
  /**
   * Per-table error, set by Power BI when row/byte caps are exceeded
   * (e.g. `"More than 1000000 rows in a query result"`). When present, the
   * row data is truncated.
   */
  error?: FabricSemanticModelError;
  /**
   * Column metadata (names + dataTypes) derived from the Arrow schema. When
   * absent, {@link toQueryResult} infers column names from the first row and
   * reports their dataTypes as `'unknown'`.
   */
  columns?: FabricSemanticModelColumn[];
}

/**
 * Column metadata, when available from the adapter.
 */
export interface FabricSemanticModelColumn {
  /** Column name, e.g. `"Sales[Amount]"` or `"[Total]"`. */
  name: string;
  /**
   * Power-BI-style dataType, e.g. `"Int64"`, `"String"`, `"Double"`,
   * `"Decimal"`, `"DateTime"`, or `"Boolean"`. Omitted when the adapter
   * cannot determine the type.
   */
  dataType?: string;
}

/**
 * Categorisation for query errors, useful for retry/UX strategies.
 *
 * - `'api'`: the service answered, but with a failure status (auth, throttle,
 *   dataset-level rejection).
 * - `'query'`: DAX query error (syntax, semantic, etc.).
 * - `'network'`: the request never reached the service (DNS, TCP, TLS,
 *   offline). There is no response to inspect, and a retry may succeed.
 * - `'overflow'`: Power BI row/byte cap exceeded; data may be truncated.
 * - `'unknown'`: could not categorise.
 *
 * `'network'` is kept distinct from `'api'` because the two demand different
 * responses: a network failure is worth retrying as-is, whereas an API failure
 * usually needs the caller to change something (re-auth, back off, fix
 * permissions).
 */
export type QueryErrorCategory =
  | 'api'
  | 'query'
  | 'network'
  | 'overflow'
  | 'unknown';

/**
 * Structured error returned by Power BI. Mirrors the
 * `DatasetExecuteQueriesError` shape, plus two optional fields the direct
 * execution paths populate.
 */
export interface FabricSemanticModelError {
  /** Power BI error code, e.g. `"DatasetExecuteQueriesError"`. */
  code?: string;
  /** Human-readable error message. */
  message: string;
  /**
   * Raw error detail for debugging: the verbatim response body for an API
   * failure, or structured `key=value` diagnostics for a network failure.
   * Never parsed; carried through so a developer can see exactly what the
   * service said.
   */
  details?: string;
  /**
   * Explicit categorisation, when the producer knows better than the position
   * of the error in the envelope.
   *
   * {@link toQueryResult} infers a category from *where* an error appears
   * (a top-level `responseError` is an API failure, a `queryError` is a DAX
   * failure, and so on). That inference is right for responses that came back
   * from the service, but it cannot distinguish a request that never left the
   * machine. The direct paths set this field so a network or unknown failure
   * is not mislabelled `'api'`.
   */
  category?: QueryErrorCategory;
  /**
   * Remediation the connector knows and the category cannot express.
   *
   * Set only where the usual reading of a status code is misleading, so a
   * caller deriving its own hint from {@link category} stays in charge
   * everywhere else.
   */
  recoveryHint?: string;
}
