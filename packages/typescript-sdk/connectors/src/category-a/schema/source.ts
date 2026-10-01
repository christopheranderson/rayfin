/**
 * `Source()` base class factory for connector entities.
 *
 * Provides SQL source mapping (schema + table) metadata to a decorated
 * entity class via inheritance. The metadata is read by `@entity()` and
 * surfaced through `EntityMetadata.source`.
 *
 * @example
 * ```typescript
 * import { entity, int } from '@microsoft/rayfin-core';
 * import { Source } from '@microsoft/rayfin-connectors';
 *
 * @entity()
 * export class Product extends Source({ schema: 'SalesLT', table: 'Products' }) {
 *   @int()
 *   id!: number;
 * }
 * ```
 */
import { RayfinSource, RayfinPrimaryKey } from '@microsoft/rayfin-core';

/**
 * Phantom carrier for the ordered primary-key tuple.
 *
 * Adds the tuple to a constructor's static type under the type-only
 * {@link RayfinPrimaryKey} key. A named interface so entity `.d.ts` files
 * reference it by name in their `extends` clause.
 *
 * @typeParam PK - The ordered tuple of primary-key property names.
 */
export interface RayfinPrimaryKeyCarrier<PK extends readonly string[]> {
  readonly [RayfinPrimaryKey]: PK;
}

/**
 * Options for the `Source()` base class factory.
 *
 * @typeParam PK - The ordered tuple of primary-key property names, captured as
 *   a `const` literal so the composite key shape flows to the client surface.
 */
export interface SourceOptions<
  PK extends readonly string[] = readonly string[],
> {
  /**
   * The SQL schema. Defaults to `'dbo'` when not specified.
   */
  schema?: string;
  /**
   * The SQL table name. Defaults to the decorated class name when not specified.
   */
  table?: string;
  /**
   * The ordered list of property names that form this entity's primary key.
   * The order is preserved end-to-end (it becomes the entity's `keyFields`).
   *
   * Omit or pass `[]` for a keyless entity — its by-key client methods are
   * stripped. Column names are not validated here (the class body does not
   * exist yet); typo-safety is enforced downstream.
   */
  primaryKey?: PK;
}

/**
 * Internal shape stored on the base class constructor under {@link RayfinSource}.
 * `schema` and `table` are optional so `@entity()` can apply defaults at
 * decoration time (resolving `table` to the subclass name).
 *
 * @internal
 */
export interface SourceMetadata {
  schema?: string;
  table?: string;
  primaryKey?: readonly string[];
}

/**
 * Creates a base class carrying SQL source mapping metadata.
 *
 * The `primaryKey` tuple travels through two channels:
 * - Runtime: stored (with `schema`/`table`) on the static {@link RayfinSource}
 *   property, read by `@entity()` which merges defaults (`schema: 'dbo'`,
 *   `table: <className>`).
 * - Compile-time: exposed on the constructor's static type under the
 *   {@link RayfinPrimaryKey} phantom, from which the client derives the
 *   entity's by-key `where` shape. This phantom is type-only — it is added by
 *   the return cast, never written as a real property, so at runtime the
 *   `[RayfinPrimaryKey]` key is absent (reading it yields `undefined`).
 *
 * `PK` defaults to `readonly []`: omitting `primaryKey` is equivalent to
 * `primaryKey: []` (keyless — no `findByKey`/`update`/`delete`). A by-key surface
 * is offered only for a non-empty tuple.
 *
 * @param options - Schema, table, and primary key to associate with the entity.
 * @returns A base class to extend.
 */
export function Source<const PK extends readonly string[] = readonly []>(
  options: SourceOptions<PK> = {}
): (new (...args: unknown[]) => object) & RayfinPrimaryKeyCarrier<PK> {
  const sourceMeta: SourceMetadata = {
    schema: options.schema,
    table: options.table,
    primaryKey: options.primaryKey,
  };
  class SourceBase {
    static [RayfinSource]: SourceMetadata = sourceMeta;
  }
  // The RayfinPrimaryKey phantom is type-only (carries the key tuple to the
  // client); it is never present at runtime, hence the assertion.
  return SourceBase as unknown as (new (...args: unknown[]) => object) &
    RayfinPrimaryKeyCarrier<PK>;
}
