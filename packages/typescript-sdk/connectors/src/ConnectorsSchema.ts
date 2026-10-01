/**
 * Schema types for the typed `client.connectors` API.
 *
 * A `ConnectorsSchema` maps a connector instance name (as declared in
 * `rayfin.yml`) to a `ConnectorMarker` produced by a connector-specific
 * package, e.g. `FabricSemanticModel<'executeQuery'>` from
 * `@microsoft/rayfin-connector-fabric-semanticmodel`.
 */

import type { EntityClass } from '@microsoft/rayfin-core';
import type {
  ConnectorType,
  FabricSqlConnectorOperationType,
} from '@microsoft/rayfin-tools-common/_internal/config';

/**
 * Supported connector types. Re-exported (via the imported binding
 * above) from `@microsoft/rayfin-tools-common` so the SDK and the
 * CLI / `rayfin.yml` validators share a single source of truth and
 * cannot drift. Builders should import `ConnectorType` from
 * `@microsoft/rayfin-connectors` rather than the tools-common
 * `_internal` path.
 */
export type { ConnectorType };

/**
 * Per-operation input/output binding.
 *
 * `TInput` / `TOutput` are phantom — the fields exist only at the type
 * level so the TS compiler can infer them through the operation catalog.
 */
export interface OperationDef<TInput = unknown, TOutput = unknown> {
  readonly __input?: TInput;
  readonly __output?: TOutput;
}

/**
 * A connector's operation catalog: a record mapping operation names to
 * their typed input/output bindings.
 */
export type OperationCatalog = Record<string, OperationDef<unknown, unknown>>;

/**
 * Type marker for a connector. Connector-specific packages export concrete
 * markers (e.g. `FabricSemanticModel<TOps>` for Cat B,
 * `GraphQLBackedConnector<TSchema, TConfig>` for Cat A) that pin the
 * resolved client shape via the `__client` phantom. The mapped type
 * {@link TypedConnectorsApi} extracts that phantom in a single branch,
 * so both Cat A (entity-oriented `RestrictedDataApi`) and Cat B
 * (operation-oriented `TypedConnectorClient`) share this contract.
 *
 * Cat B markers additionally pin an `__operations` phantom that carries
 * the operation catalog at the type level for diagnostics; it's not
 * required by the dispatcher and Cat A markers don't declare it.
 */
export interface ConnectorMarker<TClient = unknown> {
  readonly __client?: TClient;
}

/**
 * Maps connector instance names (as declared in `rayfin.yml`) to their
 * `ConnectorMarker` types.
 *
 * @example
 * ```ts
 * import type { ConnectorsSchema } from '@microsoft/rayfin-connectors';
 * import type { FabricSemanticModel } from '@microsoft/rayfin-connector-fabric-semanticmodel';
 * import type { GraphQLBackedConnector } from '@microsoft/rayfin-connector-fabric-graphql';
 *
 * export type AppConnectorsSchema = {
 *   salesModel: FabricSemanticModel<'executeQuery'>;
 *   salesDb: GraphQLBackedConnector<{ Product: typeof Product }, typeof salesDbConfig>;
 * };
 *
 * // Optional compile-time guard that the shape matches the upper-bound:
 * const _check: ConnectorsSchema = null as unknown as AppConnectorsSchema;
 * void _check;
 * ```
 */
export type ConnectorsSchema = Record<string, ConnectorMarker>;

/**
 * Options that can be supplied to a single connector operation invocation.
 * Lives in this base package because the operation-catalog shape it
 * decorates ({@link TypedConnectorClient}) is also defined here.
 */
export interface InvokeOptions {
  /** Extra headers to attach to the request. */
  headers?: Record<string, string>;
}

/**
 * The typed shape of a single `client.connectors.<name>` entry derived
 * from an operation-catalog connector marker (e.g. Cat B function
 * connectors). Each catalog key becomes a function that accepts the
 * operation's typed input and resolves to its typed output.
 */
export type TypedConnectorClient<TCatalog extends OperationCatalog> = {
  [K in keyof TCatalog & string]: TCatalog[K] extends OperationDef<
    infer TIn,
    infer TOut
  >
    ? unknown extends TIn
      ? (input?: TIn, options?: InvokeOptions) => Promise<TOut>
      : (input: TIn, options?: InvokeOptions) => Promise<TOut>
    : never;
};

/**
 * CRUD verbs a Category A (GraphQL-backed) connector may permit. Alias of
 * `FabricSqlConnectorOperationType` from `@microsoft/rayfin-tools-common`
 * so the runtime allow-list, the CLI validators, and the
 * `@microsoft/rayfin-connector-fabric-graphql` type marker stay in sync.
 */
export type CrudOperation = FabricSqlConnectorOperationType;

/**
 * Maps each CRUD verb to the `GraphQLEntityClient` method names that
 * perform it. The single source of truth used both by the runtime
 * defense-in-depth gate in `GraphQLConnectorClient` and by the
 * compile-time `MethodsFor<TOp>` mapped type in
 * `@microsoft/rayfin-connector-fabric-graphql` (which derives from this
 * tuple via `(typeof METHODS_FOR_CRUD_OPERATION)[TOp][number]`).
 *
 * Methods absent from this map (internal helpers) are
 * never gated at runtime — the allow-list only restricts the explicit
 * CRUD entry-points listed below.
 */
export const METHODS_FOR_CRUD_OPERATION = {
  read: [
    'select',
    'where',
    'orderBy',
    'first',
    'groupBy',
    'aggregate',
    'findMany',
    'findFirst',
    'findByKey',
  ],
  create: ['create'],
  update: ['update'],
  delete: ['delete'],
} as const satisfies Record<CrudOperation, readonly string[]>;

/**
 * Runtime config the Builder passes per connector at `RayfinClient`
 * construction. Mirrored from each connector's CLI-generated
 * `rayfin/connectors/<name>/schema.ts` so the runtime never has to read
 * `rayfin.yml`.
 *
 * The dispatcher routes on `connector` to pick the right runtime client
 * internally; Builders never construct clients themselves.
 */
export interface ConnectorConfig {
  /** Connector type from `rayfin.yml`. */
  connector: ConnectorType;
  /**
   * Optional CRUD allow-list (Cat A only). When provided, Cat A entity
   * client methods are gated at runtime — calling a method whose verb is
   * not in this list throws `ConnectorsError` with code
   * `OPERATION_NOT_ALLOWED`. Omit to permit every CRUD verb supported by
   * the connector. Ignored for Cat B (function-bridge) connectors.
   */
  operations?: readonly CrudOperation[];
  /**
   * Per-entity metadata keyed by entity name, mirrored from the connector's
   * generated `schema.ts`. Either the decorated entity class or an explicit
   * list of its field names.
   *
   * Supplies the default GraphQL selection used when no explicit `select` is
   * given, so `findMany(filter?)`, `findFirst(filter?)` and `findByKey`
   * return the full row, and so a create/update/delete on a read-after-write
   * dialect (SQL Database; ignored by Warehouse/Lakehouse) can read back
   * server-generated columns the caller never sent. Omitting it makes those
   * no-selection forms throw `SELECTION_REQUIRED`.
   *
   * Prefer the string-array form in code the browser loads. A decorated entity
   * class cannot be bundled: bundlers lower the decorators into an invalid
   * class expression and the app fails to parse at runtime.
   *
   * The class form additionally carries relationship cardinality (`@one` /
   * `@many`), which is **required** to select a relationship — a relationship
   * select against the array form throws
   * `ENTITIES_REQUIRED_FOR_RELATIONSHIP_SELECT`.
   */
  entities?: Record<string, EntityClass | readonly string[]>;
}

/**
 * Category of a connector failure, coarse enough that a caller can branch on
 * it without knowing which service produced the error.
 *
 * Deliberately service-neutral: `api` covers any rejection by the backing
 * service, `query` any failure the service reported while running the
 * operation, and `network` any failure that never reached it.
 */
export type ConnectorErrorCategory =
  | 'network'
  | 'api'
  | 'query'
  | 'overflow'
  | 'unknown';

/**
 * Structured error a connector returns when an operation fails.
 *
 * This is a shape connectors satisfy, not a hook they implement. A connector
 * that normalises inside its `invoke` middleware returns it directly;
 * everything downstream, including the CLI, reads it without knowing which
 * connector produced it.
 */
export interface ConnectorError {
  /** Human-readable message. Always present, so callers never render `undefined`. */
  message: string;
  /** Service error code, when the service supplied one. */
  code?: string;
  /**
   * Coarse failure category. Optional because a connector that cannot
   * classify a failure should omit it rather than guess, leaving the caller
   * on its generic fallback.
   */
  category?: ConnectorErrorCategory;
  /** Raw diagnostic detail for debugging, such as a verbatim response body. */
  details?: string;
  /**
   * Connector-supplied remediation, overriding whatever the caller would
   * otherwise derive from `category`. Set it only when the connector knows
   * something the category cannot express, such as a status code that means
   * a specific misconfiguration rather than the usual cause.
   */
  recoveryHint?: string;
}

/**
 * Failed result of a connector operation. The success arm is
 * connector-specific, so only the error arm is shared.
 */
export interface ConnectorErrorResult {
  status: 'error';
  error: ConnectorError;
}

/**
 * Narrow an operation result to the shared failed shape.
 *
 * Returns `false` for a connector that has not adopted the contract and still
 * resolves to its transport's raw envelope, so callers keep whatever handling
 * they already have for those rather than treating them as successes.
 */
export function isConnectorError(
  value: unknown
): value is ConnectorErrorResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { status?: unknown; error?: unknown };
  if (candidate.status !== 'error') {
    return false;
  }

  const error = candidate.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}
