/**
 * Internal helpers for the connectors SDK.
 *
 * Category taxonomy (Cat A vs Cat B) lives here, not in shared config,
 * because routing/transport choice is an SDK concern — `rayfin.yml` and
 * `ConnectorConfig` only declare *which* connector is used, not *how*
 * the SDK reaches it.
 */

import { getEntityMetadata, type EntityClass } from '@microsoft/rayfin-core';
import { formatGraphQLValue } from '@microsoft/rayfin-data';
import {
  Connector,
  type ConnectorType,
} from '@microsoft/rayfin-tools-common/_internal/config';

import { ConnectorsError } from './Connectors';

/**
 * The entity's value-field names to use in a GraphQL selection set, skipping
 * relationship fields (which need nested sub-selections). Each name is the
 * field's property name (DAB exposes each column under its property name).
 */
export function entityReturnColumns(entity: EntityClass): string[] {
  const { fields } = getEntityMetadata(entity);
  return Object.entries(fields)
    .filter(([, field]) => !field.relationship)
    .map(([name]) => name);
}

/**
 * The default GraphQL selection for an entity, from either its decorated class
 * or an explicit column list.
 *
 * The column-list form exists because a decorated class cannot be referenced
 * from browser code: bundlers lower the decorators into an invalid class
 * expression, and the app fails to parse at runtime. Naming the columns keeps
 * the default selection working without importing the class.
 */
export function resolveReturnColumns(
  entity: EntityClass | readonly string[] | undefined
): readonly string[] {
  if (entity === undefined) return [];
  return Array.isArray(entity)
    ? (entity as readonly string[])
    : entityReturnColumns(entity as EntityClass);
}

/**
 * Cat A (GraphQL-backed) connector types.
 *
 */
const CAT_A_GRAPHQL_CONNECTOR_TYPES = new Set<ConnectorType>([
  Connector.FabricSqlAnalytics,
  Connector.FabricWarehouse,
  Connector.FabricSql,
]);

export function isCatAGraphqlConnectorType(
  connectorType: ConnectorType
): boolean {
  return CAT_A_GRAPHQL_CONNECTOR_TYPES.has(connectorType);
}

/**
 * Connector types that write but cannot read the written row back (no T-SQL
 * `OUTPUT` clause), so their create/update/delete return
 * `DbOperationResult { result }` instead of the row. Fabric SQL Analytics is
 * excluded — it is a read-only surface and never writes.
 */
const CONNECTOR_TYPES_WITHOUT_READ_AFTER_WRITE = new Set<ConnectorType>([
  Connector.FabricWarehouse,
]);

/** Whether `connectorType` reads the written row back after a mutation. */
export function supportsReadAfterWrite(connectorType: ConnectorType): boolean {
  return !CONNECTOR_TYPES_WITHOUT_READ_AFTER_WRITE.has(connectorType);
}

/**
 * Returns the underlying `ArrayBuffer` when `value` is binary, or `undefined`.
 * A zero-length buffer is still binary, so the length is not consulted.
 */
export function asArrayBuffer(value: unknown): ArrayBuffer | undefined {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength
    ) as ArrayBuffer;
  }
  return undefined;
}

// ============================================================================
// GraphQL mutation builders for the connector entity client.
// Each builder reads the primary-key columns off the caller-supplied `where`
// object (e.g. `update({ sensorId, metricCode }, ...)`) to target a row.
// ============================================================================

type Row = Record<string, unknown>;

/**
 * The GraphQL Name production: [_A-Za-z][_0-9A-Za-z] repeated. Column
 * identifiers are spliced into the mutation document verbatim (unlike values,
 * which go through `formatGraphQLValue`), so they are validated against this
 * before use. Keys reach these helpers as `Record<string, unknown>`, past the
 * type-level narrowing that `CreateInput`/`WhereUniqueOf` provide, so this is
 * the runtime backstop for a caller-influenced identifier.
 */
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

function assertGraphQLName(name: string, context: string): string {
  if (!GRAPHQL_NAME.test(name)) {
    throw new ConnectorsError(
      `Invalid column name "${name}" in ${context}.`,
      'INVALID_COLUMN_NAME'
    );
  }
  return name;
}

/**
 * DAB `_by_pk` argument list (`col: value, …`) built from every defined entry
 * in `where`. For a composite key this emits one argument per key column, in
 * the caller's declared order.
 */
export function formatByPkArgs(where: Row): string {
  return Object.entries(where)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `${assertGraphQLName(key, 'primary key')}: ${formatGraphQLValue(value)}`
    )
    .join(', ');
}

/**
 * DAB `item: { … }` input literal built from every defined column in `data`.
 * A connector record is flat scalar columns — foreign keys included — so each
 * column serializes directly as `col: value`, with no relationship collapsing.
 */
function formatItem(data: Row): string {
  const entries = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `${assertGraphQLName(key, 'column')}: ${formatGraphQLValue(value)}`
    );
  return `{ ${entries.join(', ')} }`;
}

/** Field name a warehouse (DWSQL) mutation returns in place of the row. */
const DB_OPERATION_RESULT_FIELD = 'result';
const SELECTION_INDENT = '\n          ';

/**
 * The GraphQL query field DAB exposes for a single-row primary-key lookup:
 * the entity name with a lower-cased first letter and a `_by_pk` suffix (e.g.
 * `Reading` -\> `reading_by_pk`). Mirrors the DAB naming the mutation verbs
 * already follow (`create<Entity>` stays PascalCase; the by-pk *query* is
 * camel-cased, matching the data-path client).
 */
export function byPkQueryField(entity: string): string {
  return `${entity.charAt(0).toLowerCase()}${entity.slice(1)}_by_pk`;
}

/**
 * Build a `<entity>_by_pk(<key args>) { <columns> }` query document: a
 * single-row lookup by the full primary key.
 *
 * DAB resolves this against the primary-key index and returns the one matching
 * row (or `null`), so an incomplete key fails at the server rather than
 * silently matching the first row the way a filtered list read would.
 *
 * The selection set is `select` when the caller names columns to fetch —
 * mirroring the `_by_pk` GraphQL artifact, which returns exactly the requested
 * columns — otherwise the key columns themselves (the only columns known at
 * runtime when no projection is given). An empty `select` falls back to the
 * key columns so the query always has a non-empty selection set.
 */
export function buildByPkQuery(
  entity: string,
  where: Row,
  select?: readonly string[]
): string {
  const args = formatByPkArgs(where);
  const columns = (
    select && select.length > 0
      ? select.map((col) => assertGraphQLName(col, 'column'))
      : Object.entries(where)
          .filter(([, value]) => value !== undefined)
          .map(([key]) => assertGraphQLName(key, 'primary key'))
  ).join(SELECTION_INDENT);
  return `
      query {
        ${byPkQueryField(entity)}(${args}) {
          ${columns}
        }
      }
    `.trim();
}

/** Inputs to {@link mutationSelection}. */
interface MutationSelectionSpec {
  /** The entity's columns to request back; empty when no entity is registered. */
  returnColumns: readonly string[];
  /** Columns to select when `returnColumns` is empty (the mutation's keys/input). */
  fallback: Row;
  /** Mutation name, used in the empty-selection error. */
  context: string;
}

/**
 * The selection set for a mutation body: `DbOperationResult` for warehouse
 * connectors, otherwise `returnColumns`, or the defined keys of `fallback` when
 * `returnColumns` is empty. Throws `EMPTY_MUTATION_SELECTION` when both are empty.
 */
function mutationSelection(
  returnsResult: boolean,
  { returnColumns, fallback, context }: MutationSelectionSpec
): string {
  if (returnsResult) {
    return DB_OPERATION_RESULT_FIELD;
  }
  if (returnColumns.length > 0) {
    return returnColumns.join(SELECTION_INDENT);
  }
  const keys = Object.keys(fallback).filter(
    (key) => fallback[key] !== undefined
  );
  if (keys.length === 0) {
    throw new ConnectorsError(
      `Cannot build "${context}": no columns to return. Pass at least one input column, or register the entity on the connector (config.entities) so server-generated columns are returned.`,
      'EMPTY_MUTATION_SELECTION'
    );
  }
  return keys.join(SELECTION_INDENT);
}

/**
 * Build a `create<Entity>(item: { … }) { … }` mutation document. `returnColumns`
 * are the columns to request back; when empty, the selection falls back to the
 * supplied input columns. Warehouse connectors return {@link DbOperationResult}.
 */
export function buildCreateMutation(
  entity: string,
  input: Row,
  returnsResult = false,
  returnColumns: readonly string[] = []
): string {
  const selection = mutationSelection(returnsResult, {
    returnColumns,
    fallback: input,
    context: `create${entity}`,
  });
  return `
      mutation {
        create${entity}(item: ${formatItem(input)}) {
          ${selection}
        }
      }
    `.trim();
}

/** Build an `update<Entity>(<key args>, item: { … }) { … }` mutation document. */
export function buildUpdateMutation(
  entity: string,
  where: Row,
  data: Row,
  returnsResult = false,
  returnColumns: readonly string[] = []
): string {
  const selection = mutationSelection(returnsResult, {
    returnColumns,
    fallback: { ...where, ...data },
    context: `update${entity}`,
  });
  return `
      mutation {
        update${entity}(
          ${formatByPkArgs(where)},
          item: ${formatItem(data)}
        ) {
          ${selection}
        }
      }
    `.trim();
}

/** Build a `delete<Entity>(<key args>) { … }` mutation document. */
export function buildDeleteMutation(
  entity: string,
  where: Row,
  returnsResult = false,
  returnColumns: readonly string[] = []
): string {
  const selection = mutationSelection(returnsResult, {
    returnColumns,
    fallback: where,
    context: `delete${entity}`,
  });
  return `
      mutation {
        delete${entity}(${formatByPkArgs(where)}) {
          ${selection}
        }
      }
    `.trim();
}
