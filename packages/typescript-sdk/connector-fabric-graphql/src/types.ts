import {
  METHODS_FOR_CRUD_OPERATION,
  type ConnectorConfig,
  type ConnectorMarker,
  type ConnectorEntityClient,
  type ConnectorType,
  type CrudOperation,
  type WhereUniqueOf,
} from '@microsoft/rayfin-connectors';
import type { EntitySchema } from '@microsoft/rayfin-data';

/** Re-export of the shared CRUD-operation union from `@microsoft/rayfin-connectors`. */
export type { CrudOperation };

/**
 * The {@link ConnectorEntityClient} method names associated with a CRUD
 * operation, read from the runtime constant `METHODS_FOR_CRUD_OPERATION`.
 */
type MethodsFor<TOp extends CrudOperation> =
  (typeof METHODS_FOR_CRUD_OPERATION)[TOp][number];

/** Entity-client method names that require a declared primary key. */
type ByKeyMethod = 'findByKey' | 'update' | 'delete';

/**
 * `true` when entity `TEntity` in `TSchema` declares a usable primary key,
 * `false` when {@link WhereUniqueOf} resolves to `never` (`primaryKey: []`,
 * `primaryKey` omitted, or no `Source` phantom).
 */
type HasPrimaryKey<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema,
> = [WhereUniqueOf<TSchema[TEntity]>] extends [never] ? false : true;

/**
 * The entity client for one schema entry, restricted to the methods permitted
 * by two gates:
 * - **CRUD ops** (`TOps`) — keeps only the methods mapped to the connector's
 *   declared operations via `METHODS_FOR_CRUD_OPERATION`.
 * - **Primary key** — when the entry declares no key, {@link ByKeyMethod}
 *   (`findByKey`/`update`/`delete`) is removed from the type; `create`
 *   and the key-agnostic reads remain.
 *
 * `TDialect` is the connector's type literal; it flows into
 * `ConnectorEntityClient` so the mutation methods return `DbOperationResult`
 * for connectors without read-after-write (Fabric Warehouse) and the entity
 * row otherwise.
 */
export type RestrictedEntityClient<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema & string,
  TOps extends CrudOperation,
  TDialect extends ConnectorType = ConnectorType,
> = Pick<
  ConnectorEntityClient<TSchema, TEntity, TDialect>,
  HasPrimaryKey<TSchema, TEntity> extends true
    ? MethodsFor<TOps>
    : Exclude<MethodsFor<TOps>, ByKeyMethod>
>;

/**
 * Type-level entity API for a Category A connector: one
 * {@link RestrictedEntityClient} per entity in the schema, gated by `TOps`
 * and typed for the connector's `TDialect`.
 */
export type RestrictedDataApi<
  TSchema extends EntitySchema,
  TOps extends CrudOperation = CrudOperation,
  TDialect extends ConnectorType = ConnectorType,
> = {
  [K in keyof TSchema & string]: RestrictedEntityClient<
    TSchema,
    K,
    TOps,
    TDialect
  >;
};

/**
 * The CRUD-operation union a connector permits, read from its
 * {@link ConnectorConfig}. `operations` is a literal tuple (the CLI emits the
 * config `as const satisfies ConnectorConfig`), so `[number]` recovers the
 * exact verbs. `NonNullable` drops the `| undefined` the optional `operations?`
 * adds, so a widened `ConnectorConfig` still yields the full {@link CrudOperation}
 * union.
 */
type OpsOf<TConfig extends ConnectorConfig> = NonNullable<
  TConfig['operations']
>[number];

/**
 * Phantom marker for a Category A (GraphQL-backed) connector instance. The CLI
 * emits a per-connector `schema.ts` declaring e.g.
 * `type SalesDbSchema = GraphQLBackedConnector<{ Product: typeof Product }, typeof connectorConfig>;`,
 * and the `client.connectors.<name>` proxy resolves to a
 * {@link RestrictedDataApi} exposing only the permitted CRUD methods.
 *
 * The second parameter is the connector's own `connectorConfig` type (via
 * `typeof connectorConfig`), so the permitted operations ({@link OpsOf}) and
 * the dialect (`TConfig['connector']`) are both derived from one source. The
 * dialect drives the mutation return type: `DbOperationResult` for connectors
 * without read-after-write (Fabric Warehouse), the entity row otherwise. For
 * the literals to survive, declare the config with an
 * `as const satisfies ConnectorConfig` clause (a `: ConnectorConfig`
 * annotation widens `connector` and `operations`).
 *
 * Both parameters are phantom (type-level only) so the mapped type in
 * `@microsoft/rayfin-connectors` can infer them.
 *
 * Key each entity name to its **constructor** (`typeof Product`), not its
 * instance type. The constructor carries the `RayfinPrimaryKey` phantom from
 * `Source({ primaryKey })` used to derive the composite/custom `where` shape;
 * a bare instance entry has no phantom and is therefore treated as keyless
 * (no by-key methods).
 *
 * @example
 * ```ts
 * const connectorConfig = {
 *   connector: 'fabric-warehouse',
 *   operations: ['read', 'create', 'update', 'delete'],
 * } as const satisfies ConnectorConfig;
 *
 * type SalesDbSchema = GraphQLBackedConnector<
 *   { Product: typeof Product; Customer: typeof Customer },
 *   typeof connectorConfig
 * >;
 * ```
 */
export interface GraphQLBackedConnector<
  TSchema extends EntitySchema = EntitySchema,
  TConfig extends ConnectorConfig = ConnectorConfig,
> extends ConnectorMarker<
  RestrictedDataApi<TSchema, OpsOf<TConfig>, TConfig['connector']>
> {
  readonly __schema?: TSchema;
  readonly __config?: TConfig;
}
