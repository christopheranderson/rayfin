import type { PrimaryKeyField } from '@microsoft/rayfin-core';

/**
 * Base entity schema type for the client.
 */
export type EntitySchema = Record<string, any>;

/**
 * Clean entity keys that exclude prototype methods and functions
 */
export type CleanEntityKeys<T> = keyof {
  [K in keyof T as T[K] extends Function ? never : K]: T[K];
};

/**
 * Nested field path support with type constraints for relationships
 */
export type NestedFieldPath<T> = T extends object
  ? {
      [K in CleanEntityKeys<T>]: K extends string
        ? NonNullable<T[K]> extends (infer U)[] // Handle arrays including optional ones (posts?: Post[])
          ? U extends object
            ? `${K}.${CleanEntityKeys<U>}` | K
            : K
          : NonNullable<T[K]> extends object // Handle optional objects (category?: Category)
            ? `${K}.${CleanEntityKeys<NonNullable<T[K]>>}` | K
            : K
        : never;
    }[CleanEntityKeys<T>]
  : never;

/**
 * Type-safe field selection with nested paths
 */
export type FieldSelection<T> = readonly (
  | CleanEntityKeys<T>
  | NestedFieldPath<T>
)[];

/**
 * DAB-compliant filter input
 */
export type RelationshipIsNullFilter<T> = T extends object
  ? T extends readonly unknown[]
    ? never
    : { isNull?: boolean }
  : never;

/**
 * Filter value that can be a direct value, a filter input, or a relationship isNull filter
 */
export type FilterValue<T, K extends keyof T> =
  | T[K]
  | FilterInput<NonNullable<T[K]>>
  | FieldFilterInput<NonNullable<T[K]>>
  | (undefined extends T[K]
      ? RelationshipIsNullFilter<NonNullable<T[K]>>
      : never);

/**
 * DAB-compliant filter input type
 */
export type FilterInput<T> = {
  [K in keyof T]?: FilterValue<T, K>;
} & {
  and?: FilterInput<T>[]; // lowercase per DAB spec
  or?: FilterInput<T>[]; // lowercase per DAB spec
};

/**
 * Field-specific filter operators per DAB specification
 */
export type FieldFilterInput<T> = T extends string
  ? StringFilterInput
  : T extends number
    ? NumberFilterInput
    : T extends boolean
      ? BooleanFilterInput
      : T extends Date
        ? DateFilterInput
        : GenericFilterInput<T>;

/**
 * Comparison operators for filtering string fields (DAB-compliant).
 */
export interface StringFilterInput {
  /** Equals. */
  eq?: string;
  /** Not equals. */
  neq?: string;
  /** Greater than (lexicographic). */
  gt?: string;
  /** Greater than or equal (lexicographic). */
  gte?: string;
  /** Less than (lexicographic). */
  lt?: string;
  /** Less than or equal (lexicographic). */
  lte?: string;
  /** Contains the given substring. */
  contains?: string;
  /** Does not contain the given substring. */
  notContains?: string;
  /** Starts with the given prefix. */
  startsWith?: string;
  /** Ends with the given suffix. */
  endsWith?: string;
  /** Matches `null` (`true`) or non-`null` (`false`). */
  isNull?: boolean;
  /** Matches any value in the list. */
  in?: string[];
}

/**
 * Comparison operators for filtering numeric fields (DAB-compliant).
 */
export interface NumberFilterInput {
  /** Equals. */
  eq?: number;
  /** Not equals. */
  neq?: number;
  /** Greater than. */
  gt?: number;
  /** Greater than or equal. */
  gte?: number;
  /** Less than. */
  lt?: number;
  /** Less than or equal. */
  lte?: number;
  /** Matches `null` (`true`) or non-`null` (`false`). */
  isNull?: boolean;
  /** Matches any value in the list. */
  in?: number[];
}

/**
 * Comparison operators for filtering boolean fields (DAB-compliant).
 */
export interface BooleanFilterInput {
  /** Equals. */
  eq?: boolean;
  /** Not equals. */
  neq?: boolean;
  /** Matches `null` (`true`) or non-`null` (`false`). */
  isNull?: boolean;
  /** Matches any value in the list. */
  in?: boolean[];
}

/**
 * Comparison operators for filtering date fields.
 *
 * WARNING: DAB currently does not support comparison operators for Date fields in PostgreSQL.
 */
export interface DateFilterInput {
  /** Equals. */
  eq?: Date;
  /** Not equals. */
  neq?: Date;
  /** Greater than (after). */
  gt?: Date;
  /** Greater than or equal (on or after). */
  gte?: Date;
  /** Less than (before). */
  lt?: Date;
  /** Less than or equal (on or before). */
  lte?: Date;
  /** Matches `null` (`true`) or non-`null` (`false`). */
  isNull?: boolean;
  /** Matches any value in the list. */
  in?: Date[];
}

/**
 * Fallback equality operators for fields without a specialized filter type.
 *
 * @typeParam T - The field type being filtered.
 */
export interface GenericFilterInput<T> {
  /** Equals. */
  eq?: Partial<T>;
  /** Not equals. */
  neq?: Partial<T>;
}

/**
 * DAB pagination configuration (forward pagination only).
 *
 * Microsoft Data API Builder only supports forward pagination with `first` and `after`.
 * Backward pagination with `last` and `before` is not supported.
 *
 * @see https://learn.microsoft.com/en-us/azure/data-api-builder/keywords/after-graphql
 * @see https://learn.microsoft.com/en-us/azure/data-api-builder/keywords/first-graphql
 */
export interface PaginationConfig {
  /** Number of items to return per page */
  first?: number;
  /** Cursor to resume pagination from */
  after?: string;
}

/**
 * Forward-pagination result wrapper returned by `executePaginated()`.
 *
 * @typeParam T - The entity type contained in `items`.
 */
export interface PagedResult<T> {
  /** The records in the current page. */
  items: T[];
  /** Whether another page is available after this one. */
  hasNextPage: boolean;
  /** Cursor to pass to `after()` to fetch the next page. */
  endCursor?: string;
  /** Total count of matching records, when provided by the server. */
  totalCount?: number;
}

/**
 * DAB order by input
 */
export type OrderByInput<T> = {
  [K in keyof T]?: 'asc' | 'desc';
};

// ============================================================================
// Flexible Relationship Input Types
// ============================================================================

/**
 * Extracts the primary key field from an entity using the centralized `PrimaryKeyField` type.
 *
 * @see {@link RelationshipInput} for usage in mutation input types
 */
export type PrimaryKeyOnly<T> = PrimaryKeyField extends keyof T
  ? Pick<T, PrimaryKeyField>
  : never;

/**
 * Flexible input type for relationship fields in mutations.
 *
 * Accepts either:
 * - Full entity object (current behavior, useful when you have the object)
 * - Object with only the primary key field(s) (new ergonomic shorthand)
 *
 * @remarks
 * The runtime already handles both forms via `isRelationshipObject()` which
 * detects objects with 'id' or 'Id' properties and extracts the ID value
 * to form the foreign key (e.g., `category_id`).
 *
 * @example
 * ```typescript
 * // Option 1: Pass full object (current behavior)
 * await client.data.Todo.create({
 *   title: 'My Todo',
 *   category: { id: 'cat-123', name: 'Work', color: '#ff0000' },
 * });
 *
 * // Option 2: Pass primary-key-only object (new ergonomic shorthand)
 * await client.data.Todo.create({
 *   title: 'My Todo',
 *   category: { id: 'cat-123' },
 * });
 * ```
 */
export type RelationshipInput<T> = T | PrimaryKeyOnly<T>;

/**
 * Detects if a type is a relationship (object with a primary key that's not a primitive wrapper).
 *
 * @remarks
 * A relationship is detected as an object type that has a `PrimaryKeyField` property,
 * but is not a Date or Array (which are object types but not relationships).
 */
export type IsRelationship<T> = PrimaryKeyField extends keyof T
  ? T extends Date | Array<any>
    ? false
    : true
  : false;

/**
 * Transforms an entity type for mutation input.
 *
 * - `@one` relationship fields become `RelationshipInput<T>` (accepts full object or id-only)
 * - `@many` relationship fields (arrays) are allowed but ignored at runtime
 *   (they're managed via the FK on the "many" side, not on the parent)
 * - Primitive fields remain unchanged
 *
 * @remarks
 * This type preserves optionality: if a field is optional in the entity (e.g., `category?: Category`),
 * it remains optional in the mutation input.
 *
 * `@many` arrays can be passed for convenience but will be ignored by the GraphQL mutation.
 * To manage `@many` relationships, update the child entities' `@one` references instead.
 */
export type MutationInput<T> = {
  [K in keyof T]: NonNullable<T[K]> extends Array<any>
    ? T[K] // Allow @many relationships (ignored at runtime, managed via FK on child)
    : IsRelationship<NonNullable<T[K]>> extends true
      ?
          | RelationshipInput<NonNullable<T[K]>>
          | (undefined extends T[K] ? undefined : never)
      : T[K];
};

/**
 * Input type for creating new entities.
 * The primary key field is optional since it's typically database-generated,
 * but can be provided if the user wants to specify a particular id.
 */
export type CreateInput<T> = PrimaryKeyField extends keyof T
  ? Omit<MutationInput<T>, PrimaryKeyField> & Partial<Pick<T, PrimaryKeyField>>
  : MutationInput<T>;

/**
 * Input type for updating existing entities.
 *
 * All fields are optional. Relationship fields accept full object or primary-key-only.
 * `@many` relationship arrays are allowed but ignored at runtime.
 *
 * @example
 * ```typescript
 * // Update with primary-key-only for relationship
 * const input: UpdateInput<Todo> = {
 *   title: 'Updated Title',
 *   category: { id: 'new-cat-id' },
 * };
 * ```
 */
export type UpdateInput<T> = Partial<MutationInput<T>>;

/**
 * Input type for uniquely identifying an entity.
 * Uses the centralized PrimaryKeyField type alias.
 */
export type WhereUniqueInput<T> = { [K in PrimaryKeyField]: string };
