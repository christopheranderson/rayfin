/**
 * GraphQL type names that a Rayfin entity may not use.
 *
 * An entity name becomes a GraphQL type name in the schema built from the
 * generated DAB config, on both the data path and the connector path. That
 * schema already registers the HotChocolate scalars DAB maps SQL columns onto,
 * plus the GraphQL operation root types. Declaring an entity called `Date`
 * therefore redefines an existing type and the deploy is rejected with an
 * opaque schema-build error that names neither the entity nor the connector.
 * Rejecting the name locally keeps the failure actionable.
 */

import type { ValidationError } from './validation-errors.js';

/**
 * HotChocolate scalars present in a DAB-generated schema.
 *
 * Sourced from HotChocolate's `ScalarNames` and DAB's
 * `SupportedHotChocolateTypes`. The legacy names (`Byte`, `ByteArray`,
 * `SignedByte`, `TimeSpan`) are kept because persisted schemas authored on
 * HotChocolate 15 are replayed on the current engine.
 */
const SCALAR_TYPE_NAMES = [
  'Any',
  'Base64String',
  'Boolean',
  'Byte',
  'ByteArray',
  'Date',
  'DateTime',
  'Decimal',
  'Duration',
  'Float',
  'ID',
  'Int',
  'LocalDate',
  'LocalDateTime',
  'LocalTime',
  'Long',
  'Short',
  'SignedByte',
  'Single',
  'String',
  'Time',
  'TimeSpan',
  'UnsignedByte',
  'UnsignedInt',
  'UnsignedLong',
  'UnsignedShort',
  'URI',
  'URL',
  'UUID',
] as const;

/** GraphQL operation root types, which DAB owns in the generated schema. */
const ROOT_TYPE_NAMES = ['Query', 'Mutation', 'Subscription'] as const;

/**
 * Every GraphQL type name an entity is not allowed to take, sorted for stable
 * error output.
 *
 * @internal
 */
export const RESERVED_ENTITY_NAMES: readonly string[] = [
  ...SCALAR_TYPE_NAMES,
  ...ROOT_TYPE_NAMES,
].sort((a, b) => a.localeCompare(b));

const RESERVED_ENTITY_NAME_SET: ReadonlySet<string> = new Set(
  RESERVED_ENTITY_NAMES
);

/** The reason an entity name is unusable, or `undefined` when it is fine. */
/** @internal */
export type ReservedEntityNameReason = 'scalar' | 'root-type' | 'introspection';

/**
 * Classify `name` against the reserved GraphQL type names.
 *
 * Matching is case-sensitive because GraphQL type names are — `Date` collides
 * with the built-in scalar while `TaskDate` does not.
 *
 * @param name - The entity (GraphQL type) name to check.
 * @returns The reason the name is reserved, or `undefined` when it is usable.
 *
 * @internal
 */
export function getReservedEntityNameReason(
  name: string
): ReservedEntityNameReason | undefined {
  if (name.startsWith('__')) {
    return 'introspection';
  }
  if ((ROOT_TYPE_NAMES as readonly string[]).includes(name)) {
    return 'root-type';
  }
  if (RESERVED_ENTITY_NAME_SET.has(name)) {
    return 'scalar';
  }
  return undefined;
}

/**
 * Build the user-facing explanation for a reserved entity name.
 *
 * @internal
 */
export function describeReservedEntityName(
  name: string,
  reason: ReservedEntityNameReason
): string {
  switch (reason) {
    case 'introspection':
      return `Entity name '${name}' starts with '__', which GraphQL reserves for introspection types`;
    case 'root-type':
      return `Entity name '${name}' is a GraphQL operation root type reserved by the platform`;
    case 'scalar':
      return `Entity name '${name}' is a built-in GraphQL scalar type reserved by the platform`;
  }
}

/**
 * Build the validation error for a reserved entity name, if the name is one.
 *
 * Shared by the data-path and connector analyzers so both reject the same
 * names with the same wording; the paths differ only in whether renaming can
 * be decoupled from the underlying table.
 *
 * @param name - The entity (GraphQL type) name to check.
 * @param options - `supportsSourceMapping` when the path can keep the original
 * table via `Source({ table: '...' })`, which only connector entities can.
 * @returns The validation error, or `undefined` when the name is usable.
 *
 * @internal
 */
export function checkReservedEntityName(
  name: string,
  options: { supportsSourceMapping: boolean }
): ValidationError | undefined {
  const reason = getReservedEntityNameReason(name);
  if (!reason) {
    return undefined;
  }

  // Strip the introspection prefix so the suggested name isn't reserved too.
  const example = `${name.replace(/^_+/, '')}Record`;
  const rename = `Rename the entity to a name that is not a reserved GraphQL type (for example, '${example}')`;

  return {
    entity: name,
    message: describeReservedEntityName(name, reason),
    fix: options.supportsSourceMapping
      ? `${rename}, or pass an explicit name to @entity('...') and keep Source({ table: '...' }) pointed at the original table.`
      : `${rename}, or pass an explicit name to @entity('...').`,
  };
}
