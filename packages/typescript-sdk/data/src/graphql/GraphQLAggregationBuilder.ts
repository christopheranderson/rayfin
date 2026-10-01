import { deserializeDabResponse } from '../utils/serialization';

import type { GraphQLClient } from './GraphQLClient';
import type {
  AggregationOpName,
  AggregationSpec,
  GroupedAggregationRow,
  ScalarKeys,
} from './aggregation-types';
import { formatGraphQLValue } from './formatValue';
import type { EntitySchema, NumberFilterInput } from './types';

const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;
const OP_NAMES: readonly AggregationOpName[] = [
  'sum',
  'avg',
  'min',
  'max',
  'count',
];
const OP_NAME_SET = new Set<string>(OP_NAMES);

/**
 * Options accepted by an aggregation operation.
 *
 * @internal
 */
interface NormalizedOptions {
  field: string;
  having?: NumberFilterInput;
  distinct?: boolean;
}

/**
 * A normalized aggregation entry, produced by runtime validation.
 *
 * @internal
 */
interface NormalizedEntry {
  alias: string;
  op: AggregationOpName;
  options: NormalizedOptions;
}

/**
 * Fluent builder for a Data API Builder (DAB) `groupBy` aggregation query.
 *
 * Instances are returned from
 * {@link GraphQLQueryBuilder.groupBy | GraphQLQueryBuilder.groupBy} or
 * {@link GraphQLQueryBuilder.aggregate | GraphQLQueryBuilder.aggregate}.
 * The generated GraphQL contains only a `groupBy` selection and never
 * emits `items`, `endCursor`, or `hasNextPage`, because DAB rejects a
 * query that combines `groupBy` with `items`.
 *
 * @typeParam TSchema - The entity schema type.
 * @typeParam TEntity - The specific entity name.
 * @typeParam TGroup - The scalar keys grouped over.
 * @typeParam TSpec - The aggregation specification (alias-keyed).
 *
 * @example
 * ```typescript
 * const rows = await client.data.Order
 *   .where({ status: { eq: 'shipped' } })
 *   .groupBy(['region'])
 *   .aggregate({
 *     revenue: { sum: 'amount' },
 *     orders:  { count: 'quantity' },
 *   })
 *   .execute();
 * ```
 */
export class GraphQLAggregationBuilder<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema,
  TGroup extends readonly ScalarKeys<TSchema[TEntity]>[],
  TSpec extends AggregationSpec<TSchema[TEntity]>,
> {
  private readonly normalizedGroupBy: readonly string[];
  private readonly normalizedSpec: readonly NormalizedEntry[];

  /**
   * Creates an aggregation builder. Prefer chaining from a
   * {@link GraphQLQueryBuilder} instead of calling this directly.
   *
   * @param graphqlClient - The underlying GraphQL client.
   * @param entityPluralName - The DAB query root (lowercased pluralized entity).
   * @param filterFragment - The pre-built `filter: { ... }` GraphQL fragment
   *   (or an empty string when no `where` was supplied). Passed in so this
   *   builder does not re-implement filter serialization.
   * @param groupBy - The scalar fields to group by.
   * @param spec - The alias-keyed aggregation specification.
   */
  constructor(
    private readonly graphqlClient: GraphQLClient,
    private readonly entityPluralName: string,
    private readonly filterFragment: string,
    groupBy: TGroup,
    spec: TSpec
  ) {
    this.normalizedGroupBy = validateAndDedupeGroupBy(
      groupBy as readonly (string | number | symbol)[]
    );
    this.normalizedSpec = validateAndNormalizeSpec(spec);
  }

  /**
   * Execute the aggregation query and return one row per group.
   *
   * @returns An array of `{ fields, aggregations }` entries. When no
   *   grouping fields are supplied the array contains a single grand-total
   *   entry with an empty `fields` object.
   */
  async execute(): Promise<
    GroupedAggregationRow<TSchema[TEntity], TGroup, TSpec>[]
  > {
    const query = this.buildQuery();
    const result = await this.graphqlClient.query(query);
    return this.unwrapResponse(result);
  }

  // === Test / introspection surface ===

  /**
   * Return the generated GraphQL query string.
   *
   * @internal
   */
  public buildQueryString(): string {
    return this.buildQuery();
  }

  /**
   * Unwrap a raw GraphQL response into the SDK aggregation result shape.
   *
   * @internal
   */
  public unwrapResponse(
    response: unknown
  ): GroupedAggregationRow<TSchema[TEntity], TGroup, TSpec>[] {
    return unwrapGroupedResponse<TSchema[TEntity], TGroup, TSpec>(
      response,
      this.entityPluralName
    );
  }

  // === Query building ===

  protected buildQuery(): string {
    const args = this.filterFragment ? `(${this.filterFragment})` : '';

    const groupByArg =
      this.normalizedGroupBy.length > 0
        ? `(fields: [${this.normalizedGroupBy.join(', ')}])`
        : '';

    const fieldsSelection =
      this.normalizedGroupBy.length > 0
        ? `fields {\n              ${this.normalizedGroupBy.join('\n              ')}\n            }\n            `
        : '';

    const aggregations = this.normalizedSpec
      .map((entry) => formatAggregationLine(entry))
      .join('\n              ');

    return `
      query {
        ${this.entityPluralName}${args} {
          groupBy${groupByArg} {
            ${fieldsSelection}aggregations {
              ${aggregations}
            }
          }
        }
      }
    `.trim();
  }
}

/**
 * Runtime validation for the `groupBy` fields argument.
 *
 * Rejects non-string keys, empty strings, and any token that does not
 * match the GraphQL `Name` grammar; de-dupes while preserving order.
 *
 * @internal
 */
function validateAndDedupeGroupBy(
  fields: readonly (string | number | symbol)[]
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of fields) {
    if (typeof raw !== 'string') {
      throw new Error(
        `Invalid groupBy field: expected string, got ${typeof raw}`
      );
    }
    if (!GRAPHQL_NAME_RE.test(raw) || raw.startsWith('__')) {
      throw new Error(
        `Invalid groupBy field token "${raw}": must match GraphQL Name grammar /^[_A-Za-z][_0-9A-Za-z]*$/ and must not start with "__"`
      );
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/**
 * Runtime validation for the aggregation specification.
 *
 * Rejects empty specs, invalid alias tokens, entries whose op count is not
 * exactly one, unknown ops, and invalid field tokens. Normalizes shorthand
 * (`{ sum: 'amount' }`) into an options object.
 *
 * @internal
 */
function validateAndNormalizeSpec(
  spec: Record<string, unknown>
): readonly NormalizedEntry[] {
  if (spec === null || typeof spec !== 'object') {
    throw new Error('Aggregation specification must be an object');
  }
  const aliases = Object.keys(spec);
  if (aliases.length === 0) {
    throw new Error(
      'Aggregation specification must contain at least one entry'
    );
  }

  const out: NormalizedEntry[] = [];
  for (const alias of aliases) {
    if (!GRAPHQL_NAME_RE.test(alias) || alias.startsWith('__')) {
      throw new Error(
        `Invalid aggregation alias "${alias}": must match GraphQL Name grammar /^[_A-Za-z][_0-9A-Za-z]*$/ and must not start with "__"`
      );
    }
    const rawEntry = (spec as Record<string, unknown>)[alias];
    if (
      rawEntry === null ||
      typeof rawEntry !== 'object' ||
      Array.isArray(rawEntry)
    ) {
      throw new Error(
        `Aggregation entry for "${alias}" must be an object with exactly one operation key`
      );
    }
    // Enumerate every own key, including those whose value is undefined.
    const entryKeys = Object.keys(rawEntry as Record<string, unknown>);
    if (entryKeys.length !== 1) {
      throw new Error(
        `Aggregation entry for "${alias}" must specify exactly one operation, got ${entryKeys.length} (${entryKeys.join(', ')})`
      );
    }
    const opCandidate = entryKeys[0];
    if (!OP_NAME_SET.has(opCandidate)) {
      throw new Error(
        `Unknown aggregation operation "${opCandidate}" for alias "${alias}": expected one of ${OP_NAMES.join(', ')}`
      );
    }
    const op = opCandidate as AggregationOpName;
    const value = (rawEntry as Record<string, unknown>)[opCandidate];
    const options = normalizeOpValue(alias, op, value);
    out.push({ alias, op, options });
  }
  return out;
}

/**
 * Normalize a single operation value into `{ field, having?, distinct? }`.
 *
 * @internal
 */
function normalizeOpValue(
  alias: string,
  op: AggregationOpName,
  value: unknown
): NormalizedOptions {
  let field: unknown;
  let having: NumberFilterInput | undefined;
  let distinct: boolean | undefined;

  if (typeof value === 'string') {
    field = value;
  } else if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const opts = value as Record<string, unknown>;
    field = opts.field;
    if ('having' in opts && opts.having !== undefined) {
      if (
        typeof opts.having !== 'object' ||
        opts.having === null ||
        Array.isArray(opts.having)
      ) {
        throw new Error(
          `Aggregation "${alias}.${op}.having" must be a filter object`
        );
      }
      having = opts.having as NumberFilterInput;
    }
    if ('distinct' in opts && opts.distinct !== undefined) {
      if (typeof opts.distinct !== 'boolean') {
        throw new Error(
          `Aggregation "${alias}.${op}.distinct" must be a boolean`
        );
      }
      distinct = opts.distinct;
    }
  } else {
    throw new Error(
      `Aggregation "${alias}.${op}" value must be a field-name string or an options object`
    );
  }

  if (typeof field !== 'string') {
    throw new Error(`Aggregation "${alias}.${op}" is missing a string "field"`);
  }
  if (!GRAPHQL_NAME_RE.test(field) || field.startsWith('__')) {
    throw new Error(
      `Invalid aggregation field token "${field}" for "${alias}.${op}": must match GraphQL Name grammar /^[_A-Za-z][_0-9A-Za-z]*$/ and must not start with "__"`
    );
  }
  return { field, having, distinct };
}

/**
 * Format a single `<alias>: <op>(field: <field>, ...)` line.
 *
 * @internal
 */
function formatAggregationLine(entry: NormalizedEntry): string {
  const args: string[] = [`field: ${entry.options.field}`];
  if (entry.options.having !== undefined) {
    args.push(`having: ${formatHaving(entry.options.having)}`);
  }
  if (entry.options.distinct !== undefined) {
    args.push(`distinct: ${entry.options.distinct}`);
  }
  return `${entry.alias}: ${entry.op}(${args.join(', ')})`;
}

/**
 * Format a `having` filter object as inline GraphQL.
 *
 * `having` operates on aggregated numeric values, so scalar values reuse
 * {@link formatGraphQLValue} and nested operators recurse.
 *
 * @internal
 */
function formatHaving(
  having: NumberFilterInput | Record<string, unknown>
): string {
  const parts: string[] = [];
  for (const [op, val] of Object.entries(having)) {
    if (val === undefined) continue;
    if (!GRAPHQL_NAME_RE.test(op) || op.startsWith('__')) {
      throw new Error(
        `Invalid having operator "${op}": must match GraphQL Name grammar /^[_A-Za-z][_0-9A-Za-z]*$/ and must not start with "__"`
      );
    }
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      !(val instanceof Date)
    ) {
      parts.push(`${op}: ${formatHaving(val as Record<string, unknown>)}`);
    } else {
      parts.push(`${op}: ${formatGraphQLValue(val)}`);
    }
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Unwrap a raw DAB aggregation response into the SDK result shape.
 *
 * The response envelope is `{ data?: { <entity>: { groupBy: [...] } } }`
 * or the already-unwrapped `{ <entity>: { groupBy: [...] } }`. When no
 * grouping fields were requested the server returns a single grand-total
 * entry whose `fields` may be missing or empty.
 *
 * @internal
 */
export function unwrapGroupedResponse<
  T,
  G extends readonly ScalarKeys<T>[],
  S extends AggregationSpec<T>,
>(
  response: unknown,
  entityPluralName: string
): GroupedAggregationRow<T, G, S>[] {
  const root =
    response && typeof response === 'object' && response !== null
      ? (response as Record<string, unknown>)
      : {};
  const dataObj =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;
  const entityData = dataObj[entityPluralName];
  if (!entityData || typeof entityData !== 'object') {
    throw new Error(
      `Invalid aggregation response: missing "${entityPluralName}" field`
    );
  }
  const groupBy = (entityData as Record<string, unknown>).groupBy;
  if (!Array.isArray(groupBy)) {
    throw new Error(
      `Invalid aggregation response: expected "${entityPluralName}.groupBy" array`
    );
  }
  return groupBy.map((row: unknown) => {
    const r = (row ?? {}) as Record<string, unknown>;
    // Grouped scalar values (the `fields` sub-selection) are raw DAB scalars and
    // must go through the same deserialization as normal row queries so declared
    // entity types are honored at runtime (e.g. ISO date strings -> Date, DAB
    // string booleans -> boolean). Aggregation values are numeric and are left
    // untouched.
    const fields = deserializeDabResponse<Record<string, unknown>>(
      (r.fields ?? {}) as Record<string, unknown>
    );
    const aggregations = (r.aggregations ?? {}) as Record<string, unknown>;
    return {
      fields,
      aggregations,
    } as GroupedAggregationRow<T, G, S>;
  });
}
