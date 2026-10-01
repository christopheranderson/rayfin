import { getPrimaryKeyField } from '@microsoft/rayfin-core';
import { EntityNameResolver } from '@microsoft/rayfin-lib';

import { GraphQLAggregationBuilder } from './GraphQLAggregationBuilder';
import type { GraphQLClient } from './GraphQLClient';
import { ResponseHandler } from './ResponseHandler';
import type { AggregationSpec, ScalarKeys } from './aggregation-types';
import { formatGraphQLValue } from './formatValue';
import type {
  EntitySchema,
  FilterInput,
  OrderByInput,
  PaginationConfig,
  PagedResult,
  FieldSelection,
} from './types';

/**
 * The grouped-aggregation stage returned by {@link GraphQLQueryBuilder.groupBy}.
 *
 * This stage exists to thread the concrete tuple of grouped keys (`TGroup`)
 * through the fluent chain. `groupBy` captures the exact literal keys, and this
 * interface carries them into {@link GroupedAggregationStage.aggregate}'s result
 * type so each grouped row's `fields` is typed to *only* the grouped columns
 * (`Pick<Entity, TGroup[number]>`) instead of every scalar field.
 *
 * Only `where` and `aggregate` are exposed: the row-shaping methods
 * (`select`/`orderBy`/`first`/`after`) are intentionally absent because Data API
 * Builder rejects a query that combines `groupBy` with row selection. Those
 * combinations are therefore compile-time errors on this stage rather than
 * runtime throws.
 *
 * @typeParam TSchema - The entity schema type.
 * @typeParam TEntity - The specific entity name.
 * @typeParam TGroup - The concrete tuple of scalar keys grouped over.
 */
export interface GroupedAggregationStage<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema,
  TGroup extends readonly ScalarKeys<TSchema[TEntity]>[],
> {
  /**
   * Add filter conditions to the grouped aggregation. Repeated calls merge.
   *
   * @param conditions - The filter conditions to apply.
   * @returns This grouped stage, preserving the grouped keys for chaining.
   */
  where(
    conditions: FilterInput<TSchema[TEntity]>
  ): GroupedAggregationStage<TSchema, TEntity, TGroup>;

  /**
   * Execute a grouped aggregation over the previously chosen group keys.
   *
   * @param spec - The alias-keyed aggregation specification.
   * @returns A {@link GraphQLAggregationBuilder} whose rows' `fields` are typed
   *   to exactly the grouped keys `TGroup`.
   */
  aggregate<const TSpec extends AggregationSpec<TSchema[TEntity]>>(
    spec: TSpec
  ): GraphQLAggregationBuilder<TSchema, TEntity, TGroup, TSpec>;
}

/**
 * The row-query surface of {@link GraphQLQueryBuilder}: every capability except
 * the aggregation entry points (`aggregate`/`groupBy`).
 *
 * The chainable row methods (`select`/`where`/`orderBy`/`first`/`after`) return
 * this same type rather than the full builder, so once a query is shaped for row
 * retrieval it can never transition into an aggregation via a later `.where()`.
 * This closes the widening that a `this`-returning `where()` would otherwise
 * reintroduce, making `select(...).where(...).aggregate(...)` (and the
 * `first`/`after`/`orderBy` variants) compile-time errors. Runtime guards in
 * {@link GraphQLQueryBuilder.aggregate} still back this up for callers that
 * bypass the types.
 *
 * The non-chainable terminals (`execute`, `executePaginated`, `findFirst`) are
 * inherited unchanged from the builder.
 *
 * @typeParam TSchema - The entity schema type.
 * @typeParam TEntity - The specific entity name.
 * @typeParam TSelf - The concrete builder instance type flowing through the
 *   chain, defaulting to {@link GraphQLQueryBuilder}. Preserved polymorphically
 *   (like `Omit<this, ...>` did) so a subclass keeps its own members across the
 *   chained row methods.
 */
export type RowQueryBuilder<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema,
  TSelf = GraphQLQueryBuilder<TSchema, TEntity>,
> = Omit<
  TSelf,
  'aggregate' | 'groupBy' | 'select' | 'where' | 'orderBy' | 'first' | 'after'
> & {
  select<TFields extends FieldSelection<TSchema[TEntity]>>(
    fields: TFields
  ): RowQueryBuilder<TSchema, TEntity, TSelf>;
  where(
    conditions: FilterInput<TSchema[TEntity]>
  ): RowQueryBuilder<TSchema, TEntity, TSelf>;
  orderBy(
    order: OrderByInput<TSchema[TEntity]>
  ): RowQueryBuilder<TSchema, TEntity, TSelf>;
  first(count: number): RowQueryBuilder<TSchema, TEntity, TSelf>;
  after(cursor: string): RowQueryBuilder<TSchema, TEntity, TSelf>;
};

/**
 * Fluent GraphQL query builder for constructing and executing complex queries.
 *
 * @typeParam TSchema - The entity schema type
 * @typeParam TEntity - The specific entity name
 */
export class GraphQLQueryBuilder<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema,
> {
  protected selections: FieldSelection<TSchema[TEntity]> = [];
  private whereConditions: FilterInput<TSchema[TEntity]> = {};
  private orderByConditions: OrderByInput<TSchema[TEntity]>[] = [];
  private paginationConfig: PaginationConfig = {};
  private groupByFields: readonly ScalarKeys<TSchema[TEntity]>[] | null = null;

  private readonly entityPluralName: string;

  /**
   * Creates a query builder for a single entity.
   *
   * @param graphqlClient - The GraphQL client used to execute the built query.
   * @param entityName - The entity name to query (pluralized internally for DAB).
   */
  constructor(
    private graphqlClient: GraphQLClient,
    entityName: string
  ) {
    // Use EntityNameResolver for proper pluralization and convert to lowercase for DAB compliance
    const pluralName = EntityNameResolver.getPlural(entityName);
    this.entityPluralName = this.lowercaseFirstLetter(pluralName);
  }

  // Helper method to lowercase only the first letter of the entity name
  private lowercaseFirstLetter(str: string): string {
    if (!str) return str;
    return str.charAt(0).toLowerCase() + str.slice(1);
  }

  // === FLUENT BUILDER METHODS ===

  /**
   * Select the fields (and nested relationship fields) to return.
   *
   * Field paths use dot notation for nested relationship traversal
   * (e.g. `'customer.name'`). For filtering on a related entity, use
   * the foreign key column on `.where()` instead of a dot path.
   *
   * @param fields - The field selection. Use dot notation (e.g. `'author.name'`) for nested fields.
   * @returns This builder, for chaining.
   *
   * @example
   * ```typescript
   * await client.data.Todo
   *   .select(['id', 'title', 'category.name'])
   *   .execute();
   * ```
   */
  select<TFields extends FieldSelection<TSchema[TEntity]>>(
    fields: TFields
  ): RowQueryBuilder<TSchema, TEntity, this> {
    this.selections = [...fields];
    return this as unknown as RowQueryBuilder<TSchema, TEntity, this>;
  }

  /**
   * Add filter conditions. Repeated calls are merged together.
   *
   * Successive calls combine via DAB's lowercase `and`.
   *
   * @param conditions - The filter conditions to apply.
   * @returns This builder, for chaining.
   *
   * @example
   * ```typescript
   * await client.data.Order
   *   .where({ status: { eq: 'open' } })
   *   .where({ customer_id: { eq: currentUserId } })
   *   .execute();
   * ```
   */
  where(conditions: FilterInput<TSchema[TEntity]>): this {
    this.whereConditions = this.mergeFilters(this.whereConditions, conditions);
    return this;
  }

  /**
   * Add an order-by clause. Repeated calls append additional sort keys.
   *
   * Sort directions must be lowercase (`'asc'` or `'desc'`) per DAB.
   *
   * @param order - The order-by specification (field to `'asc'`/`'desc'`).
   * @returns This builder, for chaining.
   *
   * @example
   * ```typescript
   * await client.data.Post
   *   .orderBy({ priority: 'desc' })
   *   .orderBy({ createdAt: 'desc' })
   *   .execute();
   * ```
   */
  orderBy(
    order: OrderByInput<TSchema[TEntity]>
  ): RowQueryBuilder<TSchema, TEntity, this> {
    this.orderByConditions.push(order);
    return this as unknown as RowQueryBuilder<TSchema, TEntity, this>;
  }

  /**
   * Set the page size for this query.
   *
   * @remarks
   * `count` is bounded by DAB's maximum page size (100,000). Pass `-1` to
   * request an unbounded page, which DAB still caps at that maximum - so it
   * works only when the full result set fits under that limit. {@link execute}
   * still returns just this single page; use {@link executePaginated} with
   * {@link after} to retrieve result sets that span multiple pages.
   *
   * @param count - The maximum number of records to return in one page.
   * @returns This builder, for chaining.
   *
   * @example
   * ```typescript
   * const firstPage = await client.data.Post
   *   .first(20)
   *   .orderBy({ createdAt: 'desc' })
   *   .executePaginated();
   *
   * if (firstPage.endCursor) {
   *   const nextPage = await client.data.Post
   *     .first(20)
   *     .after(firstPage.endCursor)
   *     .orderBy({ createdAt: 'desc' })
   *     .executePaginated();
   *   console.log(nextPage.items.length);
   * }
   * ```
   */
  first(count: number): RowQueryBuilder<TSchema, TEntity, this> {
    this.paginationConfig.first = count;
    return this as unknown as RowQueryBuilder<TSchema, TEntity, this>;
  }

  /**
   * Continue pagination after the given cursor.
   *
   * @param cursor - The `endCursor` from a previous paginated result.
   * @returns This builder, for chaining.
   *
   * @example
   * ```typescript
   * const page = await client.data.Post
   *   .first(20)
   *   .after(previousCursor)
   *   .executePaginated();
   * ```
   */
  after(cursor: string): RowQueryBuilder<TSchema, TEntity, this> {
    this.paginationConfig.after = cursor;
    return this as unknown as RowQueryBuilder<TSchema, TEntity, this>;
  }

  /**
   * Start a grouped aggregation over the given scalar fields.
   *
   * `groupBy` is DAB-compliant: the fields are emitted as unquoted GraphQL
   * enum tokens and the `fields` sub-selection under `groupBy` is derived
   * from this argument, so the selection and the grouping arguments cannot
   * diverge. Grouping is mutually exclusive with row selection: the returned
   * {@link GroupedAggregationStage} deliberately omits {@link select},
   * {@link first}, {@link after}, and {@link orderBy}, so combining them with
   * grouping is now a compile-time error. (A runtime guard in
   * {@link aggregate} still backs this up for callers that bypass the types.)
   *
   * Follow with {@link GroupedAggregationStage.aggregate} to specify the
   * aggregation values, then call `.execute()` on the returned aggregation
   * builder.
   *
   * @param fields - The scalar entity fields to group by.
   * @returns A grouped-aggregation stage carrying the exact grouped keys
   *   `TGroup`, ready for a subsequent `.aggregate(...)` call.
   *
   * @example
   * ```typescript
   * const rows = await client.data.Order
   *   .where({ status: { eq: 'shipped' } })
   *   .groupBy(['region'])
   *   .aggregate({ revenue: { sum: 'amount' } })
   *   .execute();
   * ```
   */
  groupBy<const TGroup extends readonly ScalarKeys<TSchema[TEntity]>[]>(
    fields: TGroup
  ): GroupedAggregationStage<TSchema, TEntity, TGroup> {
    this.groupByFields = fields;
    return this as unknown as GroupedAggregationStage<TSchema, TEntity, TGroup>;
  }

  /**
   * Execute a grouped aggregation.
   *
   * The specification is keyed by Builder-chosen aliases; each entry value
   * is a single-operation object (`{ sum | avg | min | max | count }`)
   * whose value is either a field-name shorthand or an
   * `{ field, having?, distinct? }` options object. Aliases and field
   * tokens are validated at runtime against the GraphQL `Name` grammar.
   *
   * @remarks
   * Because DAB rejects a query that combines `groupBy` and `items`,
   * calling `aggregate` after {@link select}, {@link first}, {@link after},
   * or {@link orderBy} throws a runtime error.
   *
   * @param spec - The alias-keyed aggregation specification.
   * @returns A {@link GraphQLAggregationBuilder}; call `.execute()` to run it.
   *
   * @example
   * ```typescript
   * const rows = await client.data.Order
   *   .groupBy(['region'])
   *   .aggregate({
   *     revenue: { sum: 'amount' },
   *     orders:  { count: 'quantity' },
   *     biggest: { max: { field: 'amount', having: { gt: 500 } } },
   *   })
   *   .execute();
   * ```
   */
  aggregate<const TSpec extends AggregationSpec<TSchema[TEntity]>>(
    spec: TSpec
  ): GraphQLAggregationBuilder<
    TSchema,
    TEntity,
    // Grand-total path (no groupBy): the response carries an empty `fields`
    // object, so type the group tuple as `readonly []` to match `{}`. The
    // grouped path is intercepted by GroupedAggregationStage.aggregate, which
    // supplies the precise group tuple.
    readonly [],
    TSpec
  > {
    if (this.selections.length > 0) {
      throw new Error(
        'aggregate() cannot be combined with select(); grouped aggregation and row selection are mutually exclusive queries in Data API Builder.'
      );
    }
    if (this.paginationConfig.first !== undefined) {
      throw new Error(
        'aggregate() cannot be combined with first(); grouped aggregation does not support row pagination.'
      );
    }
    if (this.paginationConfig.after !== undefined) {
      throw new Error(
        'aggregate() cannot be combined with after(); grouped aggregation does not support row pagination.'
      );
    }
    if (this.orderByConditions.length > 0) {
      throw new Error(
        'aggregate() cannot be combined with orderBy(); row-level ordering does not apply to grouped aggregation.'
      );
    }

    const groupBy =
      this.groupByFields ?? ([] as readonly ScalarKeys<TSchema[TEntity]>[]);
    const filterFragment = this.buildFilterFragment();
    return new GraphQLAggregationBuilder(
      this.graphqlClient,
      this.entityPluralName,
      filterFragment,
      groupBy as any,
      spec
    );
  }

  // === EXECUTION METHODS ===

  /**
   * Execute the query and return a single page of matching records.
   *
   * @remarks
   * The Data API returns only one page (100 records by default, or the size set
   * via {@link first}) and does not signal whether more records exist, so lists
   * longer than one page are silently truncated. For result sets that can
   * exceed one page, use {@link executePaginated} with {@link after} to page
   * through the full set.
   *
   * @returns A single page of matching records.
   *
   * @example
   * ```typescript
   * const todos = await client.data.Todo
   *   .select(['id', 'title'])
   *   .where({ isCompleted: { eq: false } })
   *   .orderBy({ createdAt: 'desc' })
   *   .execute();
   * for (const todo of todos) {
   *   console.log(todo.title);
   * }
   * ```
   */
  async execute(): Promise<TSchema[TEntity][]> {
    this.assertNotGrouped('execute');
    const query = this.buildQuery();
    const result = await this.graphqlClient.query(query);
    const unwrapped = ResponseHandler.unwrapGraphQLResponse<TSchema[TEntity]>(
      result,
      this.entityPluralName,
      false
    );
    const items = Array.isArray(unwrapped) ? unwrapped : unwrapped.items;
    return this.unwrapNestedConnectionItems(items);
  }

  /**
   * Execute the query and return a paginated result with cursor metadata.
   *
   * @returns A {@link PagedResult} containing the items plus `endCursor` and `hasNextPage`.
   * Use this when you need to paginate forward via `.after()` on a follow-up call.
   *
   * @example
   * ```typescript
   * let cursor: string | undefined = undefined;
   * do {
   *   let query = client.data.Post
   *     .select(['id', 'title'])
   *     .first(20)
   *     .orderBy({ createdAt: 'desc' });
   *   if (cursor) {
   *     query = query.after(cursor);
   *   }
   *   const result = await query.executePaginated();
   *   for (const post of result.items) {
   *     console.log(post.title);
   *   }
   *   // Advance only when there is another page AND a cursor to resume from;
   *   // otherwise stop so we never re-fetch the first page.
   *   cursor = result.hasNextPage ? result.endCursor : undefined;
   * } while (cursor);
   * ```
   */
  async executePaginated(): Promise<PagedResult<TSchema[TEntity]>> {
    this.assertNotGrouped('executePaginated');
    const query = this.buildQueryWithPagination();
    const result = await this.graphqlClient.query(query);
    const unwrapped = ResponseHandler.unwrapGraphQLResponse<TSchema[TEntity]>(
      result,
      this.entityPluralName,
      true
    );
    const paged = unwrapped as PagedResult<TSchema[TEntity]>;
    return {
      ...paged,
      items: this.unwrapNestedConnectionItems(paged.items),
    };
  }

  /**
   * Execute the query and return only the first matching record.
   *
   * @returns The first matching record, or `null` if none match.
   */
  async findFirst(): Promise<TSchema[TEntity] | null> {
    const originalFirst = this.paginationConfig.first;
    this.paginationConfig.first = 1;

    try {
      const results = await this.execute();
      return results[0] || null;
    } finally {
      this.paginationConfig.first = originalFirst;
    }
  }

  // === PROTECTED QUERY BUILDING METHODS (for testing access) ===

  /**
   * Guard the row-execution terminals against a builder that was put into
   * grouped-aggregation mode via {@link groupBy}. The fluent types already make
   * `.groupBy(...).execute()` a compile error, so this only fires when a caller
   * bypasses the types (e.g. plain JS or an `as any` cast); without it the row
   * query would silently ignore the grouping and return ungrouped rows.
   */
  private assertNotGrouped(method: string): void {
    if (this.groupByFields !== null) {
      throw new Error(
        `${method}() cannot be called after groupBy(); call aggregate(...).execute() to run a grouped aggregation.`
      );
    }
  }

  protected buildQuery(): string {
    const fields = this.buildFieldSelection();
    const args = this.buildArguments();

    return `
      query {
        ${this.entityPluralName}${args} {
          items {
            ${fields}
          }
        }
      }
    `.trim();
  }

  protected buildQueryWithPagination(): string {
    const fields = this.buildFieldSelection();
    const args = this.buildArguments();

    return `
      query {
        ${this.entityPluralName}${args} {
          items {
            ${fields}
          }
          endCursor
          hasNextPage
        }
      }
    `.trim();
  }

  protected buildFieldSelection(): string {
    if (this.selections.length === 0) {
      return 'id';
    }

    // Group fields by their root and nested parts
    const fieldMap = new Map<string, Set<string>>();

    this.selections.forEach((field) => {
      const fieldStr = String(field);
      if (fieldStr.includes('.')) {
        const [root, nested] = fieldStr.split('.', 2);
        if (!fieldMap.has(root)) {
          fieldMap.set(root, new Set());
        }
        fieldMap.get(root)!.add(nested);
      } else {
        fieldMap.set(fieldStr, new Set());
      }
    });

    // Build GraphQL field selection
    return Array.from(fieldMap.entries())
      .map(([field, nestedFields]) => {
        if (nestedFields.size === 0) {
          return field;
        } else {
          const nestedSelection =
            Array.from(nestedFields).join('\n              ');
          // DAB GraphQL represents collections (e.g. one-to-many) as *Connection objects
          // with an `items` field. Since our selection DSL uses `posts.id` / `todos.Title`
          // for array relationships, we need to shape the GraphQL selection accordingly.
          //
          // Use EntityNameResolver to properly detect plural fields instead of crude string suffix check
          if (EntityNameResolver.isPlural(field)) {
            return `${field} {\n              items {\n                ${nestedSelection}\n              }\n            }`;
          }

          return `${field} {\n              ${nestedSelection}\n            }`;
        }
      })
      .join('\n            ');
  }

  /**
   * DAB represents collection navigation properties as "Connection" objects containing an `items` array.
   * For ergonomics (and to match our schema types like `todos?: Todo[]`), unwrap any selected nested
   * connection objects to their `items` arrays.
   */
  protected unwrapNestedConnectionItems(
    entities: TSchema[TEntity][]
  ): TSchema[TEntity][] {
    if (!entities.length || this.selections.length === 0) {
      return entities;
    }

    const nestedRoots = new Set(
      this.selections
        .map((field) => String(field))
        .filter((field) => field.includes('.'))
        .map((field) => field.split('.', 2)[0])
    );

    if (nestedRoots.size === 0) {
      return entities;
    }

    for (const entity of entities as any[]) {
      for (const root of nestedRoots) {
        const value = entity?.[root];
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Array.isArray((value as any).items)
        ) {
          entity[root] = (value as any).items;
        }
      }
    }

    return entities;
  }

  /**
   * Build only the `filter: { ... }` GraphQL fragment (no leading `(` and
   * no other arguments). Returns an empty string when no filter is set.
   * Used by the aggregation execution path.
   *
   * @internal
   */
  protected buildFilterFragment(): string {
    if (Object.keys(this.whereConditions).length === 0) {
      return '';
    }
    return `filter: ${this.buildFilterObject(this.whereConditions)}`;
  }

  private buildArguments(excludePagination = false): string {
    const args: string[] = [];

    // Filter argument (DAB object format)
    if (Object.keys(this.whereConditions).length > 0) {
      const filterObj = this.buildFilterObject(this.whereConditions);
      args.push(`filter: ${filterObj}`);
    }

    // OrderBy argument
    if (this.orderByConditions.length > 0) {
      const orderByArray = this.buildOrderByArray();
      args.push(`orderBy: ${orderByArray}`);
    }

    if (!excludePagination) {
      // Pagination arguments (DAB only supports forward pagination)
      if (this.paginationConfig.first !== undefined) {
        args.push(`first: ${this.paginationConfig.first}`);
      }

      if (this.paginationConfig.after !== undefined) {
        args.push(`after: "${this.paginationConfig.after}"`);
      }
    }

    return args.length > 0 ? `(${args.join(', ')})` : '';
  }

  private buildFilterObject(filter: FilterInput<TSchema[TEntity]>): string {
    const conditions: string[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (key === 'and') {
        const andConditions = (value as FilterInput<TSchema[TEntity]>[])
          .map((cond) => this.buildFilterObject(cond))
          .join(', ');
        conditions.push(`and: [${andConditions}]`);
      } else if (key === 'or') {
        const orConditions = (value as FilterInput<TSchema[TEntity]>[])
          .map((cond) => this.buildFilterObject(cond))
          .join(', ');
        conditions.push(`or: [${orConditions}]`);
      } else if (key === 'not') {
        const notCondition = this.buildFilterObject(
          value as FilterInput<TSchema[TEntity]>
        );
        conditions.push(`not: ${notCondition}`);
      } else {
        if (this.isRelationshipNullFilter(key, value)) {
          const foreignKeyField = `${key}_${getPrimaryKeyField()}`;
          const fieldFilter = this.buildFieldFilter(foreignKeyField, value);
          conditions.push(`${foreignKeyField}: ${fieldFilter}`);
        } else {
          const fieldFilter = this.buildFieldFilter(key, value);
          conditions.push(`${key}: ${fieldFilter}`);
        }
      }
    }

    return `{ ${conditions.join(', ')} }`;
  }

  private buildFieldFilter(fieldName: string, value: any): string {
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      const operators = Object.entries(value)
        .map(([op, val]) => {
          if (
            typeof val === 'object' &&
            !Array.isArray(val) &&
            !(val instanceof Date)
          ) {
            return `${op}: ${this.buildFieldFilter(fieldName, val)}`;
          } else {
            return `${op}: ${this.formatValue(val)}`;
          }
        })
        .join(', ');
      return `{ ${operators} }`;
    }

    return `{ eq: ${this.formatValue(value)} }`;
  }

  private isRelationshipNullFilter(key: string, value: unknown): boolean {
    if (!this.isNullFilterObject(value)) {
      return false;
    }

    if (EntityNameResolver.isPlural(key)) {
      return false;
    }

    return this.hasNestedSelectionFor(key);
  }

  private isNullFilterObject(value: unknown): value is { isNull: boolean } {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      value instanceof Date
    ) {
      return false;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length === 1 &&
      entries[0][0] === 'isNull' &&
      typeof entries[0][1] === 'boolean'
    );
  }

  private hasNestedSelectionFor(key: string): boolean {
    return this.selections.some((field) => {
      const fieldStr = String(field);
      if (!fieldStr.includes('.')) {
        return false;
      }

      const [root] = fieldStr.split('.', 2);
      return root === key;
    });
  }

  private buildOrderByArray(): string {
    // DAB expects a single OrderBy object, not an array
    // Convert from our array format to single object format
    const orderEntries: string[] = [];

    for (const order of this.orderByConditions) {
      for (const [field, direction] of Object.entries(order)) {
        // Use enum values (ASC/DESC) not quoted strings
        const enumValue = direction?.toUpperCase();
        orderEntries.push(`${field}: ${enumValue}`);
      }
    }

    return `{ ${orderEntries.join(', ')} }`;
  }

  private formatValue(value: any): string {
    return formatGraphQLValue(value);
  }

  private mergeFilters(
    existing: FilterInput<TSchema[TEntity]>,
    additional: FilterInput<TSchema[TEntity]>
  ): FilterInput<TSchema[TEntity]> {
    if (Object.keys(existing).length === 0) {
      return additional;
    }

    return { and: [existing, additional] };
  }
}
