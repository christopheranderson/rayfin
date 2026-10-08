import { getPrimaryKeyField } from '@microsoft/rayfin-core';

import { isFeatureFlagEnabled } from '../utils/feature-flags';
import { deserializeDabResponse } from '../utils/serialization';

import type { GraphQLAggregationBuilder } from './GraphQLAggregationBuilder';
import type { GraphQLClient } from './GraphQLClient';
import {
  GraphQLQueryBuilder,
  type GroupedAggregationStage,
  type RowQueryBuilder,
} from './GraphQLQueryBuilder';
import type { AggregationSpec, ScalarKeys } from './aggregation-types';
import { formatGraphQLValue } from './formatValue';
import type {
  EntitySchema,
  CreateInput,
  UpdateInput,
  WhereUniqueInput,
  FilterInput,
  OrderByInput,
  FieldSelection,
} from './types';

/**
 * Type-safe fluent client for reading and mutating a single Data API Builder
 * entity. Instances are typically obtained via the `DataApi` proxy
 * (`dataApi.<Entity>`) rather than constructed directly.
 *
 * Query methods (`select`, `where`, `orderBy`, `first`) return a chainable
 * {@link GraphQLQueryBuilder}; call `.execute()` to run the query. Direct
 * methods (`findMany`, `findFirst`, `findById`) and mutation methods
 * (`create`, `update`, `delete`, `upsert`) execute immediately.
 *
 * @typeParam TSchema - Object type mapping entity names to their types.
 * @typeParam TEntity - The entity key within `TSchema` this client targets.
 *
 * @example
 * ```typescript
 * const users = await dataApi.User
 *   .select(['id', 'name', 'email'])
 *   .where({ isActive: { eq: true } })
 *   .orderBy({ createdAt: 'desc' })
 *   .execute();
 *
 * const created = await dataApi.User.create({ name: 'Jane', email: 'jane@example.com' });
 * ```
 */
export class GraphQLEntityClient<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema,
> {
  private entityNameString: string;

  /**
   * @param graphqlClient - The underlying {@link GraphQLClient} used to send requests.
   * @param entityName - The entity name this client operates on.
   */
  constructor(
    private graphqlClient: GraphQLClient,
    entityName: TEntity
  ) {
    this.entityNameString = String(entityName);
  }

  // Helper method to lowercase only the first letter of the entity name
  private lowercaseFirstLetter(str: string): string {
    if (!str) return str;
    return str.charAt(0).toLowerCase() + str.slice(1);
  }

  // === QUERY METHODS (return builders for fluent interface) ===

  /**
   * Start a query selecting the given fields.
   *
   * Field paths use dot notation for nested relationship traversal
   * (e.g. `'category.name'`), but filtering on a related entity must use
   * the foreign key column (e.g. `category_id`), not the dot path.
   *
   * @param fields - The fields (and nested selections) to return.
   * @returns A chainable {@link GraphQLQueryBuilder}; call `.execute()` to run it.
   *
   * @example
   * ```typescript
   * const todos = await client.data.Todo
   *   .select(['id', 'title', 'isCompleted', 'category.name'])
   *   .where({ isCompleted: { eq: false } })
   *   .orderBy({ createdAt: 'desc' })
   *   .first(20)
   *   .execute();
   * ```
   */
  select<TFields extends FieldSelection<TSchema[TEntity]>>(
    fields: TFields
  ): RowQueryBuilder<TSchema, TEntity> {
    return new GraphQLQueryBuilder<TSchema, TEntity>(
      this.graphqlClient,
      this.entityNameString
    ).select(fields);
  }

  /**
   * Start a query filtered by the given conditions.
   *
   * Filter operators are object-shaped per DAB convention
   * (`{ field: { eq: value } }`, `{ field: { in: [...] } }`, etc.) and
   * combine via lowercase `and` / `or`. Filter on foreign-key columns
   * (e.g. `customer_id`) rather than the dot path of the relationship.
   *
   * @param conditions - The filter conditions to apply.
   * @returns A chainable {@link GraphQLQueryBuilder}; call `.execute()` to run it.
   *
   * @example
   * ```typescript
   * const open = await client.data.Order
   *   .where({
   *     and: [
   *       { status: { eq: 'open' } },
   *       { customer_id: { eq: currentUserId } },
   *     ],
   *   })
   *   .orderBy({ createdAt: 'desc' })
   *   .execute();
   * ```
   */
  where(
    conditions: FilterInput<TSchema[TEntity]>
  ): GraphQLQueryBuilder<TSchema, TEntity> {
    return new GraphQLQueryBuilder<TSchema, TEntity>(
      this.graphqlClient,
      this.entityNameString
    ).where(conditions);
  }

  /**
   * Start a query ordered by the given fields.
   *
   * Sort directions must be lowercase (`'asc'` or `'desc'`) per DAB.
   *
   * @param order - The order-by specification (field to `'asc'`/`'desc'`).
   * @returns A chainable {@link GraphQLQueryBuilder}; call `.execute()` to run it.
   *
   * @example
   * ```typescript
   * const recent = await client.data.Post
   *   .orderBy({ publishedAt: 'desc' })
   *   .first(10)
   *   .execute();
   * ```
   */
  orderBy(
    order: OrderByInput<TSchema[TEntity]>
  ): RowQueryBuilder<TSchema, TEntity> {
    return new GraphQLQueryBuilder<TSchema, TEntity>(
      this.graphqlClient,
      this.entityNameString
    ).orderBy(order);
  }

  /**
   * Start a query limited to the first `count` results.
   *
   * For cursor-based pagination, follow up with `.executePaginated()`
   * instead of `.execute()` so you can pass `endCursor` to a later
   * `.after()` call.
   *
   * @param count - The maximum number of records to return.
   * @returns A chainable {@link GraphQLQueryBuilder}; call `.execute()` to run it.
   *
   * @example
   * ```typescript
   * const page = await client.data.Post
   *   .first(20)
   *   .orderBy({ createdAt: 'desc' })
   *   .executePaginated();
   * console.log(page.items.length, page.endCursor);
   * ```
   */
  first(count: number): RowQueryBuilder<TSchema, TEntity> {
    return new GraphQLQueryBuilder<TSchema, TEntity>(
      this.graphqlClient,
      this.entityNameString
    ).first(count);
  }

  /**
   * Start a grouped aggregation query.
   *
   * The generated GraphQL contains only a `groupBy` selection and never
   * emits `items`, `endCursor`, or `hasNextPage`, because Data API
   * Builder rejects a query that combines `groupBy` with `items`. Follow
   * with `.aggregate(...)` and then `.execute()`.
   *
   * @param fields - The scalar fields to group by. Emitted as unquoted
   *   GraphQL enum tokens and mirrored into the `fields` sub-selection.
   * @returns A {@link GroupedAggregationStage} carrying the grouped keys;
   *   call `.aggregate(...)` next.
   *
   * @example
   * ```typescript
   * const rows = await client.data.Order
   *   .groupBy(['region'])
   *   .aggregate({ revenue: { sum: 'amount' } })
   *   .execute();
   * ```
   */
  groupBy<const TGroup extends readonly ScalarKeys<TSchema[TEntity]>[]>(
    fields: TGroup
  ): GroupedAggregationStage<TSchema, TEntity, TGroup> {
    return new GraphQLQueryBuilder<TSchema, TEntity>(
      this.graphqlClient,
      this.entityNameString
    ).groupBy(fields);
  }

  /**
   * Execute a grand-total aggregation over the entire filtered set, with
   * no grouping fields.
   *
   * @param spec - The alias-keyed aggregation specification.
   * @returns A {@link GraphQLAggregationBuilder}; call `.execute()` to run it.
   */
  aggregate<const TSpec extends AggregationSpec<TSchema[TEntity]>>(
    spec: TSpec
  ): GraphQLAggregationBuilder<
    TSchema,
    TEntity,
    // Grand-total: no grouping keys, so `fields` is an empty `{}` at runtime.
    readonly [],
    TSpec
  > {
    return new GraphQLQueryBuilder<TSchema, TEntity>(
      this.graphqlClient,
      this.entityNameString
    ).aggregate(spec);
  }

  // === DIRECT QUERY METHODS ===

  /**
   * Fetch all records matching an optional filter.
   *
   * @param filter - Optional filter conditions. Omit to fetch all records.
   * @returns The matching records.
   */
  async findMany(
    filter?: FilterInput<TSchema[TEntity]>
  ): Promise<TSchema[TEntity][]> {
    const builder = new GraphQLQueryBuilder<TSchema, TEntity>(
      this.graphqlClient,
      this.entityNameString
    );
    if (filter) {
      builder.where(filter);
    }
    return builder.execute();
  }

  /**
   * Fetch the first record matching an optional filter.
   *
   * @param filter - Optional filter conditions.
   * @returns The first matching record, or `null` if none match.
   */
  async findFirst(
    filter?: FilterInput<TSchema[TEntity]>
  ): Promise<TSchema[TEntity] | null> {
    const builder = new GraphQLQueryBuilder<TSchema, TEntity>(
      this.graphqlClient,
      this.entityNameString
    ).first(1);
    if (filter) {
      builder.where(filter);
    }
    const results = await builder.execute();
    return results[0] || null;
  }

  /**
   * Fetch a single record by its primary key.
   *
   * Use this instead of `findByPk` (which does not exist on this client)
   * and instead of `.where({ id: { eq: x } }).execute()` when you want
   * the single-record convenience and null-on-missing semantics.
   *
   * @param id - The primary key value to look up.
   * @returns The matching record, or `null` if not found.
   *
   * @example
   * ```typescript
   * const todo = await client.data.Todo.findById('11111111-2222-3333-4444-555555555555');
   * if (!todo) {
   *   console.log('Not found');
   *   return;
   * }
   * console.log(todo.id);
   * ```
   */
  async findById(id: string): Promise<TSchema[TEntity] | null> {
    const queryName = `${this.lowercaseFirstLetter(this.entityNameString)}_by_pk`;
    const pkField = getPrimaryKeyField();

    const query = `
      query {
        ${queryName}(${pkField}: ${this.formatValue(id)}) {
          ${pkField}
        }
      }
    `;

    try {
      const result = await this.graphqlClient.query(query);
      const entityData = result.data?.[queryName] || result[queryName] || null;
      return entityData
        ? deserializeDabResponse<TSchema[TEntity]>(entityData)
        : null;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  // === MUTATION METHODS ===

  /**
   * Create a new record.
   *
   * For relationship fields, pass `{ id: '...' }` as the value - the
   * client converts that into the corresponding foreign key column on
   * the wire (e.g. `category: { id: 'abc' }` becomes `category_id: 'abc'`).
   *
   * @param input - The fields for the new record. Relationship objects are
   *   converted to their foreign-key values.
   * @returns The created record.
   *
   * @example
   * ```typescript
   * const created = await client.data.Todo.create({
   *   title: 'Write the proposal',
   *   isCompleted: false,
   *   category: { id: categoryId },
   *   user_id: claims.sub,
   * });
   * console.log('Created todo', created.id);
   * ```
   */
  async create(
    input: CreateInput<TSchema[TEntity]>
  ): Promise<TSchema[TEntity]> {
    const mutationName = `create${this.entityNameString}`;
    const mutation = this.buildCreateMutationString(input);

    const result = await this.graphqlClient.mutation(mutation);
    const entityData = this.extractMutationResult(result, mutationName);
    const deserialized = deserializeDabResponse<TSchema[TEntity]>(entityData);
    return this.nestRelationshipFields(deserialized, input);
  }

  /**
   * Update an existing record identified by its primary key.
   *
   * Only the fields present in `data` are sent; omitted fields are untouched.
   *
   * @param where - The unique key identifying the record to update.
   * @param data - The fields to change.
   * @returns The updated record.
   *
   * @example
   * ```typescript
   * const updated = await client.data.Todo.update(
   *   { id: todoId },
   *   { isCompleted: true }
   * );
   * console.log('Updated', updated.id, updated.isCompleted);
   * ```
   */
  async update(
    where: WhereUniqueInput<TSchema[TEntity]>,
    data: UpdateInput<TSchema[TEntity]>
  ): Promise<TSchema[TEntity]> {
    const mutationName = `update${this.entityNameString}`;
    const mutation = this.buildUpdateMutationString(where, data);

    const result = await this.graphqlClient.mutation(mutation);
    const entityData = this.extractMutationResult(result, mutationName);
    const deserialized = deserializeDabResponse<TSchema[TEntity]>(entityData);
    return this.nestRelationshipFields(deserialized, data);
  }

  /**
   * Delete a record identified by its primary key.
   *
   * DAB returns the row before deletion.
   *
   * @param where - The unique key identifying the record to delete.
   * @returns The deleted record.
   *
   * @example
   * ```typescript
   * await client.data.Todo.delete({ id: todoId });
   * ```
   */
  async delete(
    where: WhereUniqueInput<TSchema[TEntity]>
  ): Promise<TSchema[TEntity]> {
    const mutationName = `delete${this.entityNameString}`;
    const mutation = this.buildDeleteMutationString(where);

    const result = await this.graphqlClient.mutation(mutation);
    const entityData = this.extractMutationResult(result, mutationName);
    return deserializeDabResponse<TSchema[TEntity]>(entityData);
  }

  /**
   * Update a record if it exists, otherwise create it.
   *
   * @param where - The unique key used to check for an existing record.
   * @param create - The fields to use when creating a new record.
   * @param update - The fields to apply when updating an existing record.
   * @returns The created or updated record.
   */
  async upsert(
    where: WhereUniqueInput<TSchema[TEntity]>,
    create: CreateInput<TSchema[TEntity]>,
    update: UpdateInput<TSchema[TEntity]>
  ): Promise<TSchema[TEntity]> {
    const id = this.extractId(where);
    const existing = await this.findById(id);
    if (existing) {
      return await this.update(where, update);
    }
    return await this.create(create);
  }

  // === PROTECTED MUTATION BUILDING METHODS (for testing access) ===

  protected buildCreateMutationString(
    input: CreateInput<TSchema[TEntity]>
  ): string {
    const mutationName = `create${this.entityNameString}`;
    const fieldsToReturn = this.getDefaultFields(input);

    return `
      mutation {
        ${mutationName}(item: ${this.formatMutationInput(input)}) {
          ${fieldsToReturn}
        }
      }
    `.trim();
  }

  protected buildUpdateMutationString(
    where: WhereUniqueInput<TSchema[TEntity]>,
    data: UpdateInput<TSchema[TEntity]>
  ): string {
    const mutationName = `update${this.entityNameString}`;
    const pkField = getPrimaryKeyField();
    const id = this.extractId(where);
    const fieldsToReturn = this.getDefaultFields(data);

    return `
      mutation {
        ${mutationName}(
          ${pkField}: ${this.formatValue(id)},
          item: ${this.formatMutationInput(data)}
        ) {
          ${fieldsToReturn}
        }
      }
    `.trim();
  }

  protected buildDeleteMutationString(
    where: WhereUniqueInput<TSchema[TEntity]>
  ): string {
    const mutationName = `delete${this.entityNameString}`;
    const pkField = getPrimaryKeyField();
    const id = this.extractId(where);

    return `
      mutation {
        ${mutationName}(${pkField}: ${this.formatValue(id)}) {
          ${pkField}
        }
      }
    `.trim();
  }

  // === PROTECTED HELPER METHODS (for testing access) ===

  protected getDefaultFields(data: any): string {
    const fields: string[] = [];
    const dedupeForeignKeys = isFeatureFlagEnabled('cli-minor-fixes');
    const relationshipForeignKeys = dedupeForeignKeys
      ? this.getRelationshipForeignKeys(data)
      : new Set<string>();

    // Process all entries with unified logic
    Object.entries(data).forEach(([key, value]) => {
      // Skip undefined values
      if (value === undefined) {
        return;
      }

      // Handle relationship objects by adding foreign key fields
      if (this.isRelationshipObject(value)) {
        const foreignKeyField = `${key}_${getPrimaryKeyField()}`;
        if (!fields.includes(foreignKeyField)) {
          fields.push(foreignKeyField);
        }
      }
      // Handle primitive fields (exclude other object types)
      else if (this.isPrimitiveField(value)) {
        // cli-minor-fixes: drop an explicit FK scalar when the same FK is also
        // derived from a relationship object so it is selected only once.
        const isDuplicateForeignKey =
          relationshipForeignKeys.has(key) || fields.includes(key);
        if (!dedupeForeignKeys || !isDuplicateForeignKey) {
          fields.push(key);
        }
      }
    });

    // Ensure the PK field is always included and at the beginning
    if (!fields.includes(getPrimaryKeyField())) {
      fields.unshift(getPrimaryKeyField());
    }
    return fields.join('\n          ');
  }

  protected formatMutationInput(data: any): string {
    const entries: string[] = [];
    const dedupeForeignKeys = isFeatureFlagEnabled('cli-minor-fixes');
    const relationshipForeignKeys = dedupeForeignKeys
      ? this.getRelationshipForeignKeys(data)
      : new Set<string>();

    // Process all entries with unified logic
    Object.entries(data).forEach(([key, value]) => {
      // Skip undefined values
      if (value === undefined) {
        return;
      }

      // Handle relationship objects by converting to foreign key
      if (this.isRelationshipObject(value)) {
        const foreignKeyField = `${key}_${getPrimaryKeyField()}`;
        const foreignKeyValue = this.formatValue(this.getRelationshipId(value));
        entries.push(`${foreignKeyField}: ${foreignKeyValue}`);
      }
      // Handle primitive fields (exclude other object types)
      else if (this.isPrimitiveField(value)) {
        // cli-minor-fixes: drop an explicit FK scalar that collides with a
        // relationship-derived FK so `item: { ... }` names it only once.
        if (!dedupeForeignKeys || !relationshipForeignKeys.has(key)) {
          entries.push(`${key}: ${this.formatValue(value)}`);
        }
      }
    });

    return `{ ${entries.join(', ')} }`;
  }

  private getRelationshipForeignKeys(data: any): Set<string> {
    return new Set(
      Object.entries(data)
        .filter(([, value]) => this.isRelationshipObject(value))
        .map(([key]) => `${key}_${getPrimaryKeyField()}`)
    );
  }

  /**
   * Checks if a value represents a relationship object (has 'id' property)
   */
  private isRelationshipObject(value: any): value is { id: any } {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      ('id' in value || 'Id' in value)
    );
  }

  /**
   * Extracts the ID value from a relationship object, handling both 'id' and 'Id' casing
   */
  private getRelationshipId(value: any): any {
    if ('id' in value) {
      return value.id;
    }
    if ('Id' in value) {
      return value.Id;
    }
    throw new Error('No ID field found in relationship object');
  }

  /**
   * Checks if a value is a primitive field (not a complex object)
   */
  private isPrimitiveField(value: any): boolean {
    return !(
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    );
  }

  // === PRIVATE HELPER METHODS ===

  private formatValue(value: any): string {
    return formatGraphQLValue(value);
  }

  protected extractId(where: WhereUniqueInput<TSchema[TEntity]>): string {
    return where[getPrimaryKeyField()];
  }

  private extractMutationResult(
    result: any,
    operationName: string
  ): TSchema[TEntity] {
    if (result?.data?.[operationName]) {
      return result.data[operationName];
    }

    if (result[operationName]) {
      return result[operationName];
    }

    throw new Error(`Failed to extract result from ${operationName} mutation`);
  }

  /**
   * Transforms flat FK fields (e.g. category_id) in mutation responses back into
   * nested relationship objects (e.g. `category: { id: "..." }`) based on the
   * relationship keys present in the original input.
   */
  private nestRelationshipFields(
    responseData: TSchema[TEntity],
    inputData: CreateInput<TSchema[TEntity]> | UpdateInput<TSchema[TEntity]>
  ): TSchema[TEntity] {
    const result = { ...responseData } as any;

    Object.entries(inputData).forEach(([key, value]) => {
      if (value !== undefined && this.isRelationshipObject(value)) {
        const foreignKeyField = `${key}_${getPrimaryKeyField()}`;
        if (foreignKeyField in result) {
          result[key] = { [getPrimaryKeyField()]: result[foreignKeyField] };
        }
      }
    });

    return result;
  }

  private isNotFoundError(error: any): boolean {
    return (
      error?.message?.includes('not found') ||
      error?.message?.includes('404') ||
      error?.extensions?.code === 'NOT_FOUND'
    );
  }
}
