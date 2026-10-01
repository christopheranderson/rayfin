import type { ConnectorConfig } from '@microsoft/rayfin-connectors';

/**
 * Input payload for the Kusto `executeQuery` operation.
 *
 * Callers only ever pass the KQL `query`. The cluster query endpoint and
 * database are connector-owned routing values resolved at `connector add`
 * time and injected into the outbound payload by the {@link kusto} runtime
 * middleware, so they are intentionally *not* part of this input shape.
 */
export interface ExecuteQueryInput {
  /** KQL query text. */
  query: string;
  /**
   * Optional correlation id. The {@link kusto} runtime generates one when the
   * caller omits it and forwards it in the payload; the connector function
   * (`rayfin_kusto_v1`) relays it as the `x-ms-client-request-id` header so a
   * query can be correlated across services **without the id ever appearing in
   * the response body** (the function is a pure byte pump). Mirrors how
   * `rayfin_semantic_model_v1` keeps correlation out of the streamed body.
   */
  clientRequestId?: string;
}

/**
 * Input payload for the Kusto `executeCommand` operation.
 *
 * Carries a Kusto **management** (control) command — the text must begin with a
 * leading dot (e.g. `.show databases`, `.alter table ... policy ...`). Unlike
 * {@link ExecuteQueryInput}, this routes to the cluster's `/v1/rest/mgmt`
 * endpoint rather than `/v1/rest/query`. As with `executeQuery`, the cluster
 * URI and database are connector-owned routing values injected by the
 * {@link kusto} runtime middleware, so they are intentionally *not* part of
 * this input shape.
 */
export interface ExecuteCommandInput {
  /** Kusto management command text; must start with a leading dot (`.`). */
  command: string;
  /**
   * Optional correlation id. The {@link kusto} runtime generates one when the
   * caller omits it and forwards it in the payload, exactly as for
   * {@link ExecuteQueryInput}; the connector function relays it as the
   * `x-ms-client-request-id` header, so the id never appears in the response
   * body.
   */
  clientRequestId?: string;
}

/**
 * Connector-owned configuration for a `kusto` connector instance.
 *
 * Emitted into the connector's CLI-generated
 * `rayfin/connectors/<name>/schema.ts` as the `connectorConfig` value and
 * passed to `RayfinClient` per connector. Unlike the generic
 * `ConnectorConfig`, it pins the Kusto routing values so the {@link kusto}
 * middleware can merge them into the outbound `executeQuery` payload without
 * the caller ever supplying them. Keeping these keys here — rather than on the
 * shared `rayfin.yml` `ConnectorConfigSettings` — means no Kusto-specific field
 * leaks onto every other connector type or into the host contract.
 */
export interface KustoConnectorConfig extends ConnectorConfig {
  /** Discriminant fixing this config to the `kusto` connector. */
  connector: 'kusto';
  /**
   * Absolute https cluster query URI, e.g.
   * `https://<id>.z<n>.kusto.fabric.microsoft.com`. Resolved by
   * `rayfin connector add` from the bound Eventhouse / KQL Database item.
   */
  queryServiceUri: string;
  /** Resolved KQL database name the query runs against. */
  databaseName: string;
}

/**
 * Raw Kusto v1 response document, relayed **verbatim** by the connector
 * function (`rayfin_kusto_v1`).
 *
 * The function is a pure byte pump: it no longer buffers, parses, transforms, or
 * re-serializes the Kusto response into a `{ status, output, errors }` envelope.
 * Instead the native Kusto v1 `{ Tables }` document flows straight through, and
 * {@link toQueryResult} transforms it into the connector output shape
 * client-side — the same split that keeps `rayfin_semantic_model_v1` a byte
 * pump (its Arrow stream is parsed by the SDK, never synthesized in the UDF).
 */
export interface KustoQueryResponse {
  /** Result and metadata tables in Kusto v1 native shape. */
  Tables?: KustoV1Table[];
}

/**
 * Response envelope returned by the Kusto `executeCommand` operation.
 *
 * Kusto management commands return the same v1 tabular shape as queries (one or
 * more result tables), so this mirrors {@link KustoQueryResponse}. It is kept as
 * a distinct name so the command response can diverge from the query response
 * later (e.g. command-only metadata) without a breaking rename, and so callers
 * can reason about the two operations independently at the type level.
 */
export type KustoCommandResponse = KustoQueryResponse;

/**
 * A table in the Kusto v1 native response.
 */
export interface KustoV1Table {
  /** Kusto table name, such as `"Table_0"` or `"PrimaryResult"`. */
  TableName?: string;
  /** Column metadata in row order. */
  Columns?: KustoV1Column[];
  /**
   * Row-major values. A `QueryResult` table may append a trailing non-array
   * error object after its data rows; {@link toQueryResult} strips it.
   */
  Rows?: unknown[];
}

/**
 * Column metadata in the Kusto v1 native response.
 */
export interface KustoV1Column {
  /** Column name. */
  ColumnName?: string;
  /** Kusto scalar type, such as `"string"` or `"datetime"`. */
  ColumnType?: string;
  /** Legacy/.NET type name, used as a fallback when `ColumnType` is absent. */
  DataType?: string;
}

/**
 * A JSON-native Kusto result table.
 */
export interface KustoTable {
  /** Kusto table name, such as `"PrimaryResult"`. */
  name: string;
  /** Column metadata in row order. */
  columns: KustoColumn[];
  /** Row-major values aligned with `columns`. */
  rows: unknown[][];
}

/**
 * Kusto column metadata.
 */
export interface KustoColumn {
  /** Column name. */
  name: string;
  /** Kusto scalar type, such as `"string"`, `"long"`, or `"datetime"`. */
  type: string;
}
