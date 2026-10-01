/**
 * Connector-path entity client (Category A, GraphQL-backed) and its
 * composite/custom primary-key type derivation.
 *
 * Split out from `GraphQLConnectorClient` so the per-connector proxy and the
 * per-entity client each live in their own file. The composite-key typing is
 * owned here; the connector type surface in
 * `@microsoft/rayfin-connector-fabric-graphql` only gates the CRUD verbs.
 */

import type { EntityClass } from '@microsoft/rayfin-core';
import { deserializeDabResponse } from '@microsoft/rayfin-data';
import type {
  GraphQLClient,
  EntitySchema,
  FilterInput,
  OrderByInput,
  AggregationSpec,
  GraphQLAggregationBuilder,
  GroupedAggregationStage,
  ScalarKeys,
} from '@microsoft/rayfin-data';
import { type ConnectorType } from '@microsoft/rayfin-tools-common/_internal/config';

import { ConnectorsError } from '../Connectors';
import {
  buildByPkQuery,
  buildCreateMutation,
  buildDeleteMutation,
  buildUpdateMutation,
  byPkQueryField,
  resolveReturnColumns,
  supportsReadAfterWrite,
} from '../utils';

import { ConnectorGraphQLQueryBuilder } from './ConnectorGraphQLQueryBuilder';
import type {
  BuilderFor,
  ConnectorFieldSelection,
  CreateInput,
  GuardInvalidPk,
  InstanceOf,
  MutationResult,
  Row,
  ScalarColumnsOf,
  UpdateInput,
  WhereUniqueOf,
} from './types';

/** Internal runtime shape of a primary-key `where` object (any key columns). */
type EntityKey = Record<string, unknown>;

/**
 * Connector-path entity client (Category A, GraphQL-backed), returned by
 * `GraphQLConnectorClient` for `client.connectors.<name>.<Entity>`.
 *
 * Reads go through `ConnectorGraphQLQueryBuilder`, the connector-path
 * query builder that supports relationships nested to arbitrary depth.
 * The by-key mutations (`update`/`delete`) identify the target row by
 * the caller-supplied `where` object, whose entries **are** the primary-key
 * columns — so composite, custom, or keyless keys work at runtime without any
 * single-`id` assumption and without threading a key list through the runtime.
 * This is a deliberate sibling of (not a subclass of) the data-path client, so
 * the data path's single-`id` behavior is never perturbed.
 *
 * The record type is the schema entry's **instance** ({@link InstanceOf} —
 * the entry is the entity constructor, which carries the static primary-key
 * phantom); only the by-key `where` is further derived, via
 * {@link WhereUniqueOf}, so the
 * composite-key typing lives on this class and
 * `@microsoft/rayfin-connector-fabric-graphql` needs no method overrides. The
 * only type parameters are the schema and the entity key; nothing derived is
 * exposed for callers to (mis)set.
 */
export class ConnectorEntityClient<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema,
  TDialect extends ConnectorType = ConnectorType,
> {
  private readonly entityName: string;

  /** Whether this connector's mutations return {@link DbOperationResult} instead of the row. */
  private readonly returnsResult: boolean;

  /**
   * The entity's scalar columns (relationships excluded), from its decorator
   * metadata or an explicit column list. Used as the default GraphQL
   * selection: mutations return the full row (including server-generated
   * columns the caller did not send), and reads (`findMany` / `findFirst` /
   * `findByKey`) return the full row when no explicit selection is given.
   * Empty when neither was provided, which makes those no-selection forms
   * throw `SELECTION_REQUIRED`.
   */
  private readonly columns: readonly string[];

  /**
   * The decorated class, when one was supplied. Only the class carries
   * relationship cardinality, so a column list leaves this undefined and
   * relationship selects then throw `ENTITIES_REQUIRED_FOR_RELATIONSHIP_SELECT`.
   */
  private readonly entityClass: EntityClass | undefined;

  constructor(
    private readonly graphqlClient: GraphQLClient,
    entityName: TEntity,
    connectorType: TDialect,
    entity?: EntityClass | readonly string[]
  ) {
    this.entityName = String(entityName);
    this.returnsResult = !supportsReadAfterWrite(connectorType);
    this.columns = resolveReturnColumns(entity);
    // A class is a function; a column list is not. `Array.isArray` does not
    // narrow a `readonly string[]` union, so test the class side instead.
    this.entityClass = typeof entity === 'function' ? entity : undefined;
  }

  // === READS — key-agnostic, delegate to the connector query builder ===

  select<const TFields extends readonly string[]>(
    fields: TFields & ConnectorFieldSelection<Row<TSchema[TEntity]>, TFields>
  ): BuilderFor<TSchema, TEntity> {
    return this.builder().select(fields);
  }

  where(
    conditions: FilterInput<Row<TSchema[TEntity]>>
  ): BuilderFor<TSchema, TEntity> {
    return this.builder().where(conditions);
  }

  orderBy(
    order: OrderByInput<Row<TSchema[TEntity]>>
  ): BuilderFor<TSchema, TEntity> {
    return this.builder().orderBy(order);
  }

  first(count: number): BuilderFor<TSchema, TEntity> {
    return this.builder().first(count);
  }

  /**
   * Start a grouped aggregation query on the connector path. The generated
   * GraphQL contains only a `groupBy` selection and never emits an `items`
   * connection. Follow with `.aggregate(...)` and then `.execute()`.
   */
  groupBy<const TGroup extends readonly ScalarKeys<Row<TSchema[TEntity]>>[]>(
    fields: TGroup
  ): GroupedAggregationStage<
    Record<TEntity, Row<TSchema[TEntity]>>,
    TEntity,
    TGroup
  > {
    return this.builder().groupBy(fields);
  }

  /**
   * Run a grand-total aggregation over the entire filtered set on the
   * connector path, with no grouping fields.
   */
  aggregate<const TSpec extends AggregationSpec<Row<TSchema[TEntity]>>>(
    spec: TSpec
  ): GraphQLAggregationBuilder<
    Record<TEntity, Row<TSchema[TEntity]>>,
    TEntity,
    readonly [],
    TSpec
  > {
    return this.builder().aggregate(spec);
  }

  /**
   * Fetch all matching rows. Call as `findMany(fields, filter?)` to project
   * specific columns, or `findMany(filter?)` to return the full row (an array
   * first argument is the selection; anything else is the filter).
   */
  findMany<const TFields extends readonly string[]>(
    fields:
      | (TFields & ConnectorFieldSelection<Row<TSchema[TEntity]>, TFields>)
      | undefined,
    filter?: FilterInput<Row<TSchema[TEntity]>>
  ): Promise<Row<TSchema[TEntity]>[]>;
  findMany(
    filter?: FilterInput<Row<TSchema[TEntity]>>
  ): Promise<Row<TSchema[TEntity]>[]>;
  async findMany(
    fields?: readonly string[] | FilterInput<Row<TSchema[TEntity]>>,
    filter?: FilterInput<Row<TSchema[TEntity]>>
  ): Promise<Row<TSchema[TEntity]>[]> {
    const isSelectionArg = Array.isArray(fields);
    const selectedFields =
      isSelectionArg && fields.length > 0 ? fields : undefined;
    const where = isSelectionArg
      ? filter
      : ((fields as FilterInput<Row<TSchema[TEntity]>> | undefined) ?? filter);
    const builder = this.select((selectedFields ?? this.columns) as never);
    if (where) builder.where(where);
    return builder.execute();
  }

  /**
   * Fetch the first matching row (or `null`). Call as `findFirst(fields, filter?)`
   * to project specific columns, or `findFirst(filter?)` to return the full row
   * (an array first argument is the selection; anything else is the filter).
   */
  findFirst<const TFields extends readonly string[]>(
    fields:
      | (TFields & ConnectorFieldSelection<Row<TSchema[TEntity]>, TFields>)
      | undefined,
    filter?: FilterInput<Row<TSchema[TEntity]>>
  ): Promise<Row<TSchema[TEntity]> | null>;
  findFirst(
    filter?: FilterInput<Row<TSchema[TEntity]>>
  ): Promise<Row<TSchema[TEntity]> | null>;
  async findFirst(
    fields?: readonly string[] | FilterInput<Row<TSchema[TEntity]>>,
    filter?: FilterInput<Row<TSchema[TEntity]>>
  ): Promise<Row<TSchema[TEntity]> | null> {
    const isSelectionArg = Array.isArray(fields);
    const selectedFields =
      isSelectionArg && fields.length > 0 ? fields : undefined;
    const where = isSelectionArg
      ? filter
      : ((fields as FilterInput<Row<TSchema[TEntity]>> | undefined) ?? filter);
    const builder = this.select(
      (selectedFields ?? this.columns) as never
    ).first(1);
    if (where) builder.where(where);
    const [first] = await builder.execute();
    return first ?? null;
  }

  /**
   * Fetch a single row by its primary key, or `null` if none matches.
   * `where` takes the entity's composite/custom key. With no `select`, the full
   * row is returned; pass `select` to narrow to specific scalar columns
   * (relationship and dotted paths are rejected — use the query builder for
   * related data). The result type tracks the projection.
   */
  findByKey(
    where: WhereUniqueOf<TSchema[TEntity]>
  ): Promise<Row<TSchema[TEntity]> | null>;
  findByKey<
    const TFields extends readonly ScalarColumnsOf<Row<TSchema[TEntity]>>[],
  >(
    where: WhereUniqueOf<TSchema[TEntity]>,
    select: TFields
  ): Promise<Pick<Row<TSchema[TEntity]>, TFields[number]> | null>;
  async findByKey(
    where: WhereUniqueOf<TSchema[TEntity]>,
    select?: readonly string[]
  ): Promise<Row<TSchema[TEntity]> | null> {
    const field = byPkQueryField(this.entityName);
    const result = await this.graphqlClient.query(
      buildByPkQuery(
        this.entityName,
        where as unknown as EntityKey,
        select ?? this.columns
      )
    );
    const row = result?.[field];
    return row == null
      ? null
      : deserializeDabResponse<Row<TSchema[TEntity]>>(row);
  }

  private builder(): BuilderFor<TSchema, TEntity> {
    return new ConnectorGraphQLQueryBuilder<
      Record<TEntity, Row<TSchema[TEntity]>>,
      TEntity
    >(this.graphqlClient, this.entityName, this.entityClass);
  }

  // === MUTATIONS — identify the row by its composite/custom key ===

  async create(
    input: GuardInvalidPk<
      TSchema[TEntity],
      CreateInput<InstanceOf<TSchema[TEntity]>>
    >
  ): Promise<MutationResult<TDialect, Row<TSchema[TEntity]>>> {
    return this.run(
      `create${this.entityName}`,
      buildCreateMutation(
        this.entityName,
        input as unknown as EntityKey,
        this.returnsResult,
        this.columns
      )
    );
  }

  async update(
    where: WhereUniqueOf<TSchema[TEntity]>,
    data: UpdateInput<InstanceOf<TSchema[TEntity]>>
  ): Promise<MutationResult<TDialect, Row<TSchema[TEntity]>>> {
    return this.run(
      `update${this.entityName}`,
      buildUpdateMutation(
        this.entityName,
        where as unknown as EntityKey,
        data as unknown as EntityKey,
        this.returnsResult,
        this.columns
      )
    );
  }

  async delete(
    where: WhereUniqueOf<TSchema[TEntity]>
  ): Promise<MutationResult<TDialect, Row<TSchema[TEntity]>>> {
    return this.run(
      `delete${this.entityName}`,
      buildDeleteMutation(
        this.entityName,
        where as unknown as EntityKey,
        this.returnsResult,
        this.columns
      )
    );
  }

  /**
   * Send a mutation document and return its result: for warehouse (DWSQL)
   * connectors the `DbOperationResult` verbatim, otherwise the deserialized row.
   */
  private async run(
    name: string,
    document: string
  ): Promise<MutationResult<TDialect, Row<TSchema[TEntity]>>> {
    const result = await this.graphqlClient.mutation(document);
    const row = result?.[name];
    if (row == null) {
      throw new ConnectorsError(
        `Connector mutation "${name}" on entity "${this.entityName}" returned no data.`,
        'MUTATION_NO_RESULT'
      );
    }
    if (this.returnsResult) {
      return row as MutationResult<TDialect, Row<TSchema[TEntity]>>;
    }
    return deserializeDabResponse<Row<TSchema[TEntity]>>(row) as MutationResult<
      TDialect,
      Row<TSchema[TEntity]>
    >;
  }
}
