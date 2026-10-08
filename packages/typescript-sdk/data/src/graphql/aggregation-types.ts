import type { NumberFilterInput } from './types';

/**
 * Scalar keys of an entity — string, number, boolean, or Date.
 *
 * Excludes relationship, array, and nested object fields, matching the
 * `<Entity>ScalarFields` GraphQL enum that Data API Builder (DAB) generates
 * for aggregation and grouping.
 *
 * @typeParam T - The entity type.
 */
export type ScalarKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends string | number | boolean | Date
    ? K
    : never;
}[keyof T];

/**
 * Numeric keys of an entity, used to constrain the `field` argument of
 * `sum`, `avg`, `min`, and `max` aggregations.
 *
 * @typeParam T - The entity type.
 */
export type NumericKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends number ? K : never;
}[keyof T];

/**
 * Options object for a single aggregation operation.
 *
 * @typeParam F - The allowed field name type for this operation.
 */
export interface AggregationFieldOptions<F extends string | number | symbol> {
  /** The scalar field to aggregate over (emitted as an unquoted GraphQL enum token). */
  field: F;
  /** Optional `having` filter applied to the aggregated numeric value. */
  having?: NumberFilterInput;
  /** When true, aggregate only distinct values of `field`. */
  distinct?: boolean;
}

/**
 * Shorthand-or-options value for an aggregation operation.
 *
 * @typeParam F - The allowed field name type for this operation.
 */
export type AggregationOpValue<F extends string | number | symbol> =
  | F
  | AggregationFieldOptions<F>;

/**
 * All valid aggregation operation entries for an entity, before the
 * exactly-one-key constraint is applied.
 *
 * All operations (`sum`/`avg`/`min`/`max`/`count`) accept only numeric
 * fields: Data API Builder generates every aggregation's `field` argument
 * as the `<Entity>NumericAggregateFields` enum, and `count` is documented as
 * "count of numeric values". Non-numeric fields (for example a `uuid` id or
 * a `text` column) are rejected by the server.
 *
 * @typeParam T - The entity type.
 */
export interface AggregationOps<T> {
  sum: AggregationOpValue<NumericKeys<T>>;
  avg: AggregationOpValue<NumericKeys<T>>;
  min: AggregationOpValue<NumericKeys<T>>;
  max: AggregationOpValue<NumericKeys<T>>;
  count: AggregationOpValue<NumericKeys<T>>;
}

/**
 * The five aggregation operation names supported by DAB.
 */
export type AggregationOpName = keyof AggregationOps<unknown>;

/**
 * A discriminated union that enforces exactly one key from `All`.
 *
 * Each variant requires one key and marks all other keys as `?: never`, so
 * fresh object literals that specify more than one operation are rejected
 * at compile time.
 *
 * @typeParam All - The map of allowed keys to their value types.
 */
export type ExactlyOne<All> = {
  [K in keyof All]: { [P in K]: All[P] } & {
    [P in Exclude<keyof All, K>]?: never;
  };
}[keyof All];

/**
 * A single aggregation-spec entry: exactly one operation with its value.
 *
 * @typeParam T - The entity type.
 */
export type AggregationEntry<T> = ExactlyOne<AggregationOps<T>>;

/**
 * The full aggregation specification: a map of Builder-chosen aliases to
 * single-operation entries.
 *
 * @typeParam T - The entity type.
 */
export type AggregationSpec<T> = Record<string, AggregationEntry<T>>;

/**
 * Result type for a single aggregation entry.
 *
 * `count` aggregations are non-nullable `number`; `sum`/`avg`/`min`/`max`
 * are `number | null` because DAB emits them as nullable and SQL returns
 * `NULL` over empty or all-null groups.
 *
 * @typeParam E - The aggregation entry type.
 */
export type AggregationResult<E> = E extends { count: unknown }
  ? number
  : number | null;

/**
 * Result shape of a grouped aggregation query.
 *
 * @typeParam T - The entity type.
 * @typeParam G - The grouped scalar keys.
 * @typeParam S - The aggregation specification.
 */
export interface GroupedAggregationRow<
  T,
  G extends readonly ScalarKeys<T>[],
  S extends AggregationSpec<T>,
> {
  /** The grouped column values for this group. */
  fields: Pick<T, G[number] & keyof T>;
  /** The aggregation values, keyed by Builder-chosen alias. */
  aggregations: { [K in Extract<keyof S, string>]: AggregationResult<S[K]> };
}
