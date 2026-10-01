import { PermissionConfig, RoleDeclaration } from './options.js';

/** @internal Metadata symbol used to store entity configuration. */
export const RayfinEntity: unique symbol = Symbol.for(
  'microsoft.rayfin.entity'
);

// Explicit marker set only by the @entity() decorator.
// This prevents classes that only have field decorators
// from being treated as DAB entities.
/** @internal Marker symbol set only by the `@entity()` decorator. */
export const RayfinEntityMarker: unique symbol = Symbol.for(
  'microsoft.rayfin.entity.marker'
);

// Storage folder metadata (set by @blob()).
/** @internal Metadata symbol used to store storage folder configuration. */
export const RayfinStorageFolder: unique symbol = Symbol.for(
  'microsoft.rayfin.storage.folder'
);

// Source mapping metadata (set by the experimental Source() base class factory).
// Stored as a static property on the constructor so @entity() can read it via
// the prototype chain when applied to a subclass of Source({...}).
export const RayfinSource: unique symbol = Symbol.for(
  'microsoft.rayfin.source'
);

// Phantom (type-carrying) marker for a connector entity's composite/custom
// primary key declared via `Source({ primaryKey: [...] })`. Type-level only:
// the ordered key tuple sits on the constructor's STATIC side and never carries
// a runtime value; the client reads it to derive the entity's `WhereUnique` shape.
export const RayfinPrimaryKey: unique symbol = Symbol.for(
  'microsoft.rayfin.primarykey'
);

/** @internal Type guard that returns whether a value is a decorated entity class. */
export const isRayfinEntity = (obj: unknown): obj is EntityClass => {
  return (
    isEntityClass(obj) &&
    obj[Symbol.metadata]?.[RayfinEntity] !== undefined &&
    obj[Symbol.metadata]?.[RayfinEntityMarker] === true
  );
};

/** @internal Resolved storage folder configuration stored in metadata. */
export interface StorageFolderMetadata {
  name: string;
  folderName: string;
  /**
   * Server behavior when an object already exists at the resolved path.
   * `'error'` (default) returns `Conflict`; `'overwrite'` replaces and
   * requires the role to grant `update`.
   */
  onConflict: 'error' | 'overwrite';
  /**
   * Maximum object size for this folder. Number = bytes; string carries a
   * unit (`'2mb'`). Normalized to a byte count when emitted to the JSON DSL.
   */
  maxSize?: number | string;
  /** Allowed content types as MIME globs. Empty/undefined allows any type. */
  allowedContentTypes?: string[];
  permissions: PermissionConfig;
  roles?: RoleDeclaration[];
  /**
   * App-specific typed fields declared on the `@blob` class (e.g.,
   * `@text() team_id!: string`). Values are persisted to the
   * `storage.objects.user_metadata` JSON column at upload time and exposed
   * to the policy DSL as `item.<field>`.
   */
  fields?: Record<string, FieldMetadata<any>>;
}

/** @internal Constructor type carrying storage folder metadata. */
export interface StorageFolderClass<in out T = unknown> extends constructor<T> {
  [Symbol.metadata]:
    | (DecoratorMetadataObject & {
        [RayfinStorageFolder]?: StorageFolderMetadata;
      })
    | null;
}

/** @internal Type guard that returns whether a value is a decorated storage folder class. */
export const isRayfinStorageFolder = (
  obj: unknown
): obj is StorageFolderClass => {
  return (
    isEntityClass(obj) &&
    obj[Symbol.metadata]?.[RayfinStorageFolder] !== undefined
  );
};

/**
 * Field format enum for decorator metadata.
 *
 * Defines the set of supported field formats that decorators can use
 * to specify the database column type and serialization format.
 *
 * When adding a format here, also add the matching category to `CanonicalDataType`
 * (packages/host/Microsoft.Rayfin.Common/Models/Canonical/CanonicalSchemaModels.cs)
 * and map the database types it produces in every `IDbTypeCanonicalizer` implementation.
 * Schema drift detection only understands types Rayfin can create, so a format with no
 * category is treated as out of scope: it is reported to the user and left untouched.
 */
export enum FieldFormat {
  /** Free-form string text (maps to a variable-length string column). */
  Text = 'text',
  /** UUID/GUID identifier. */
  Uuid = 'uuid',
  /** Integer number. */
  Int = 'int',
  /** Fixed-point decimal number. */
  Decimal = 'decimal',
  /** Boolean true/false value. */
  Boolean = 'boolean',
  /** Date or date-time value. */
  Date = 'date',
  /** Email address (validated string). */
  Email = 'email',
}

/**
 * Canonical primary key field name as a string literal type.
 *
 * All type-level references to the PK field name across rayfin-core and
 * rayfin-data use this alias instead of hardcoded `'id'` literals.
 */
export type PrimaryKeyField = 'id';

/**
 * Return the canonical primary key field name at runtime.
 *
 * All runtime references to the PK field name across rayfin-core and
 * rayfin-data call this function instead of using hardcoded `'id'` literals.
 */
export function getPrimaryKeyField(): PrimaryKeyField {
  return 'id';
}

/**
 * Structural contract for all entity classes decorated with \@entity().
 *
 * Entities must either omit `id` entirely (database-generated)
 * or declare `id` as a `string`. Non-string IDs are rejected at compile time.
 *
 * The property name `id` aligns with the {@link PrimaryKeyField} type alias,
 * which is the single source of truth for the PK field name.
 */
export interface IEntity {
  /** Optional primary key; omit for database-generated IDs. */
  id?: string;

  /** Arbitrary additional entity properties. */
  [key: string]: any;
}

/** Constructor type for a class producing instances of `T`. */
export type constructor<T> = new (...args: unknown[]) => T;
/**
 * Constructor type for a class decorated with `@entity()`, carrying entity metadata.
 *
 * @typeParam T - The entity instance type.
 */
export interface EntityClass<in out T = unknown> extends constructor<T> {
  [Symbol.metadata]:
    | (DecoratorMetadataObject & {
        [RayfinEntity]?: EntityMetadata;
      })
    | null;
}

/**
 * An instance of a decorated entity class.
 *
 * @typeParam T - The entity instance type.
 */
export interface EntityInstance<T> extends Object {
  /** The entity class that produced this instance. */
  constructor: EntityClass<T>;
}

/**
 * Extracts the entity instance type from an {@link EntityClass}.
 *
 * @typeParam T - The entity class type.
 */
export type FromEntityClass<T extends EntityClass> =
  T extends EntityClass<infer U> ? U : never;

function isEntityClass<T>(obj: unknown): obj is EntityClass<T> {
  return typeof obj === 'function' && 'name' in obj && obj.name !== 'Function';
}

/** Maps Rayfin scalar keys to their corresponding TypeScript types. */
export interface ScalarMapping {
  /** The `string` scalar maps to TypeScript `string`. */
  string: string;
  /** The `number` scalar maps to TypeScript `number`. */
  number: number;
  /** The `boolean` scalar maps to TypeScript `boolean`. */
  boolean: boolean;
  /** The `Date` scalar maps to the JavaScript `Date` object. */
  Date: Date;
  /** The `Buffer` scalar maps to a Node.js `Buffer`. */
  Buffer: Buffer;
}

/** @internal Mapping from scalar key to its string tag, used by the schema analyzer. */
export const ScalarToStringTags: Record<keyof ScalarMapping, string> = {
  string: 'String',
  number: 'Number',
  boolean: 'Boolean',
  Date: 'Date',
  Buffer: 'Buffer',
};

/**
 * Resolves a scalar key (such as `'string'`) to the canonical scalar type name
 * (such as `'String'`) used by the generated schema.
 *
 * @typeParam T - The scalar key to resolve.
 */
export type Scalar<T extends keyof ScalarMapping> = ScalarMapping[T];

/** Union of all canonical scalar type names supported by Rayfin fields. */
export type Scalars = ScalarMapping[keyof ScalarMapping];

/** Union of all scalar key identifiers (the keys of {@link ScalarMapping}). */
export type ScalarTypes = keyof ScalarMapping;

/** Base structural type for an entity used as a relationship target. */
export type EntityBase = Object;

/**
 * Any value a field's type parameter may take: a scalar, an enum (array of
 * string literals), or a related entity.
 */
export type FieldType = ScalarTypes | Scalars[] | EntityBase;

/**
 * Narrows a {@link FieldType} to its scalar form, or `never` if it is not a
 * scalar field.
 *
 * @typeParam T - The field type to narrow.
 */
export type ScalarFieldType<T extends FieldType> = T extends ScalarTypes
  ? T
  : never;

/**
 * Resolves a scalar field type to its runtime value type (for example, the
 * `'string'` scalar resolves to `string`).
 *
 * @typeParam T - The scalar field type to resolve.
 */
export type ScalarValueType<T extends ScalarFieldType<any>> =
  T extends ScalarTypes ? Scalar<T> : never;

/**
 * Narrows a {@link FieldType} to its enum form (an array of string literals),
 * or `never` if it is not an enum field.
 *
 * @typeParam T - The field type to narrow.
 */
export type EnumFieldType<T extends FieldType> = T extends Scalars[]
  ? NoInfer<T>
  : never;

/**
 * Resolves an enum field type to the union of its allowed member values.
 *
 * @typeParam T - The enum field type to resolve.
 */
export type EnumValueType<T extends EnumFieldType<any>> = T extends (infer U)[]
  ? U
  : never;

/**
 * Narrows a {@link FieldType} to the entity class it relates to, or `never` if
 * it is not a relationship field.
 *
 * @typeParam T - The field type to narrow.
 */
export type RelationFieldType<T extends FieldType> = T extends EntityBase
  ? EntityClass<T>
  : never;

/**
 * Resolves the type permitted for a field's `default` value, derived from
 * whether the field is a scalar or an enum.
 *
 * @typeParam T - The field type whose default value type is being resolved.
 */
export type DefaultFieldType<T extends FieldType> =
  T extends ScalarFieldType<T>
    ? ScalarValueType<T>
    : T extends EnumFieldType<T>
      ? EnumValueType<T>
      : never;

// Relationships

/** The set of supported relationship cardinalities. */
export enum RelationshipTypes {
  /** A to-one relationship (references a single related entity). */
  one = 'one',
  /** A to-many relationship (references a collection of related entities). */
  many = 'many',
}

/**
 * Metadata describing a single entity field, captured by field decorators.
 *
 * @typeParam T - The field's underlying type.
 * @typeParam TPropType - The resolved scalar type of the field.
 */
export interface FieldMetadata<
  T extends FieldType,
  TPropType = ScalarFieldType<T>,
> {
  /** The field's logical format (for example, `string`, `int`, or `uuid`). */
  format: FieldFormat;
  /** The resolved TypeScript scalar type of the field, when applicable. */
  jsType?: TPropType;
  /** Minimum allowed value (for numeric fields) or length (for string fields). */
  min?: number;
  /** Maximum allowed value (for numeric fields) or length (for string fields). */
  max?: number;
  /** Total number of significant digits for decimal/numeric fields. */
  precision?: number;
  /** Number of digits to the right of the decimal point for decimal fields. */
  scale?: number;
  /** Regular expression the field value must match. */
  regex?: RegExp;
  /** The set of allowed values when the field is constrained to an enum. */
  enum?: EnumFieldType<T>;
  /** Whether the field may be omitted (nullable). */
  isOptional?: boolean;
  /** Whether the field's value must be unique across the entity. */
  isUnique?: boolean;
  /** Default value applied when none is provided. */
  default?: DefaultFieldType<T>;
  /**
   * Override for the underlying database column name.
   *
   * Set via the `column` option on a field decorator
   * (for example, `@text({ column: 'Display_Name' })`). When unset, the
   * TypeScript property name is used as the column name.
   */
  columnName?: string;
  /** Relationship metadata when the field references another entity. */
  relationship?: {
    /** Resolver returning the related entity class. */
    target: () => RelationFieldType<T>;
    /** The cardinality of the relationship. */
    type: RelationshipTypes;
    sourceFields?: string[];
    targetFields?: string[];
  };
  /** Whether the field is a Rayfin-managed system type rather than user data. */
  isSystemType?: boolean;
}

/** @internal Type guard that returns whether a value is {@link FieldMetadata}. */
export const isFieldMetadata = (
  obj: unknown
): obj is FieldMetadata<FieldType> => {
  return (
    obj !== null && typeof obj === 'object' && Object.hasOwn(obj, 'format')
  );
};

/** Metadata describing a decorated entity: its name, fields, permissions, and roles. */
export interface EntityMetadata {
  /** The entity's name. */
  name: string;
  /** Field metadata keyed by field name. */
  fields: Record<string, FieldMetadata<any>>;
  /** Access-control configuration for the entity. */
  permissions: PermissionConfig;
  /** Role declarations associated with the entity, when present. */
  roles?: RoleDeclaration[];
  /**
   * Raw connector source mapping carried in from the experimental
   * `Source({ schema, table })` base class. Both fields are optional here
   * because defaults are resolved downstream (in `SchemaAnalyzer`) where the
   * SQL dialect and resolved entity name are known — e.g. PostgreSQL defaults
   * the schema to `public` rather than `dbo`.
   */
  source?: { schema?: string; table?: string; primaryKey?: readonly string[] };
}

/** @internal Merges incoming field metadata into existing metadata. */
export const upsertFieldMetadata = (
  existing: FieldMetadata<any> = {} as FieldMetadata<any>,
  incoming: Partial<FieldMetadata<any>>
): FieldMetadata<any> => {
  const merged: FieldMetadata<any> = { ...existing };

  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) {
      // TODO: this might be too strict
      if (
        merged[key as keyof FieldMetadata<any>] !== undefined &&
        merged[key as keyof FieldMetadata<any>] !== value
      ) {
        throw new Error(
          `Conflicting field metadata for key '${key}': existing value '${merged[key as keyof FieldMetadata<any>]}' vs incoming value '${value}'`
        );
      }
      merged[key as keyof FieldMetadata<any>] = value;
    }
  }

  return merged;
};

/** @internal Merges incoming permissions into existing permissions. */
export const upsertPermissions = (
  existing: PermissionConfig,
  incoming: PermissionConfig
): PermissionConfig => {
  const merged: PermissionConfig = { ...existing };

  for (const [role, perms] of Object.entries(incoming)) {
    if (!merged[role]) {
      merged[role] = perms;
    } else {
      throw new Error(`Conflicting permissions for role '${role}'`);
    }
  }

  return merged;
};

/** @internal Returns (creating if needed) the entity metadata for a class. */
export const getEntityMetadata = <T extends EntityClass>(
  entity: T
): EntityMetadata => {
  if (!entity[Symbol.metadata]?.[RayfinEntity]) {
    entity[Symbol.metadata]![RayfinEntity] = {
      name: entity.name,
      fields: {},
      permissions: {},
      roles: [],
    };
  }

  return entity[Symbol.metadata]![RayfinEntity]!;
};

/** @internal Returns the storage folder metadata for a class, if present. */
export const tryGetStorageFolderMetadata = <T extends StorageFolderClass>(
  folder: T
): StorageFolderMetadata | undefined => {
  return folder[Symbol.metadata]?.[RayfinStorageFolder];
};

/** @internal Returns (creating if needed) the storage folder metadata for a class. */
export const getStorageFolderMetadata = <T extends StorageFolderClass>(
  folder: T
): StorageFolderMetadata => {
  if (!folder[Symbol.metadata]?.[RayfinStorageFolder]) {
    folder[Symbol.metadata]![RayfinStorageFolder] = {
      name: folder.name,
      folderName: folder.name,
      onConflict: 'error',
      permissions: {},
      roles: [],
      fields: {},
    };
  }

  return folder[Symbol.metadata]![RayfinStorageFolder]!;
};
