/**
 * Decorator system for \@microsoft/rayfin-core
 *
 * These decorators store metadata at runtime using TC39 Stage 3 decorator metadata.
 * The Rayfin CLI reads this metadata to generate DAB-compliant configuration.
 * Metadata is stored via Symbol.metadata for runtime introspection and validation.
 */

import {
  SimpleAction,
  RoleDeclarationOptions,
  RoleDeclaration,
} from '../options.js';
import {
  EntityClass,
  constructor,
  IEntity,
  EntityMetadata,
  FieldMetadata,
  FieldFormat,
  RayfinEntity,
  RayfinEntityMarker,
  RayfinSource,
  RayfinPrimaryKey,
  RayfinStorageFolder,
  RelationshipTypes,
  upsertFieldMetadata,
  upsertPermissions,
  Scalars,
} from '../schema.js';
import { EMAIL_REGEX } from '../utils/email.js';

import {
  getStorageFolderMetadataFromContext,
  type RayfinDecoratorContext,
} from './internal-shared.js';

// Stage-3 decorators: Symbol.metadata is not yet typed in lib.d.ts

(Symbol as any).metadata ??= Symbol('Symbol.metadata');

function getDefaultConfig(name?: string): EntityMetadata {
  return {
    name: name as string,
    fields: {},
    permissions: {},
    roles: [],
  };
}

function getEntityMetadataFromContext(context: RayfinDecoratorContext) {
  if (context.metadata !== undefined) {
    if (!context.metadata[RayfinEntity]) {
      context.metadata[RayfinEntity] = getDefaultConfig(
        context.kind === 'class' ? context.name!.toString() : undefined
      );
    } else if (
      context.metadata[RayfinEntity].name === undefined &&
      context.kind === 'class'
    ) {
      context.metadata[RayfinEntity].name = context.name!.toString();
    }
    return context.metadata[RayfinEntity] as EntityMetadata;
  } else {
    // TODO: if Symbol.metadata is not supported, we may need to fallback to a different mechanism
    throw new Error(
      'Decorator metadata is not supported in this environment. Ensure that the TypeScript compiler is configured to emit decorator metadata.'
    );
  }
}

function normalizeActions(
  actions: SimpleAction | SimpleAction[]
): SimpleAction[] {
  return Array.isArray(actions) ? actions : [actions];
}

function ensureRelationshipResolver<U extends EntityClass>(
  resolver: () => U
): () => U {
  if (typeof resolver !== 'function') {
    throw new Error(
      'Relationship target must be provided as a resolver function: use () => EntityName'
    );
  }

  return resolver;
}

/**
 * Accepted `@entity()` targets. A class extending `Source({...})` carries the
 * static {@link RayfinPrimaryKey} phantom and is treated as a connector entity
 * (any key shape). Every other class is a data-path entity constrained by
 * {@link IEntity}, preserving the compile-time `id: string` guarantee.
 *
 * @internal
 */
type EntityDecoratorTarget =
  | constructor<IEntity>
  | (constructor<object> & { readonly [RayfinPrimaryKey]: readonly string[] });

/**
 * Marker decorator to indicate this class should be analyzed as a DAB entity.
 *
 * Entity settings inferred from class name and conventions:
 * - Entity name: kebab-case class name (e.g., "Todo" → "todo")
 * - Source table: pluralized snake_case name (e.g., "Todo" → "todos")
 * - Schema: default schema for the target database dialect
 *
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;
 * }
 * ```
 *
 * @param name - Optional explicit entity name; defaults to the class name.
 * @returns A class decorator that registers the entity.
 */
export function entity(name?: string) {
  return function <T extends EntityDecoratorTarget>(
    target: T,
    context: ClassDecoratorContext<T>
  ): void {
    if (context.kind !== 'class') {
      throw new Error('@entity() decorator can only be applied to classes');
    }
    if (context.metadata?.[RayfinStorageFolder]) {
      throw new Error(
        '@entity() and @blob() decorators cannot be used on the same class'
      );
    }
    const config = getEntityMetadataFromContext(context);

    // Mark this class as an entity for export filtering.
    // (Other decorators may create metadata, but only @entity() should make it an entity.)
    context.metadata![RayfinEntityMarker] = true;

    if (name) {
      config.name = name;
    }

    // Connector entities declare SQL source mapping and a composite/custom
    // primary key by extending Source({...}); read that inherited metadata and
    // store it on the entity metadata. Data-path entities do not extend Source,
    // so this is a no-op for them.
    const inheritedSource = (target as unknown as Record<symbol, unknown>)[
      RayfinSource
    ] as
      | { schema?: string; table?: string; primaryKey?: readonly string[] }
      | undefined;
    if (inheritedSource) {
      config.source = {
        schema: inheritedSource.schema ?? 'dbo',
        table: inheritedSource.table ?? context.name!.toString(),
        primaryKey: inheritedSource.primaryKey,
      };
    }
  };
}

/**
 * Class-level role decorator.
 *
 * Declares permissions for a built-in role (`'authenticated'` or
 * `'anonymous'`) with optional typed policy and field visibility.
 *
 * @param roleName - The role name (`'authenticated'` or `'anonymous'`)
 * @param actions - The actions this role can perform
 * @param options - Optional policy and field visibility configuration
 *
 * @example
 * ```typescript
 * import { entity, role, uuid, text, date } from '@microsoft/rayfin-core';
 *
 * @entity()
 * @role('authenticated', '*', {
 *   policy: (claims, item) => claims.sub.eq(item.user_id),
 *   exclude: ['secret'],
 * })
 * export class Todo {
 *   @uuid() id!: string;
 *   @text() user_id!: string;
 *   @text() title!: string;
 *   @text({ optional: true }) secret?: string;
 *   @date() createdAt!: Date;
 * }
 * ```
 */
export function role<TEntity extends object = object>(
  roleName: 'authenticated' | 'anonymous',
  actions: SimpleAction | SimpleAction[],
  options?: RoleDeclarationOptions<TEntity>
): (
  target: constructor<TEntity>,
  context: ClassDecoratorContext<constructor<TEntity>>
) => void {
  return function (
    _target: constructor<TEntity>,
    context: ClassDecoratorContext<constructor<TEntity>>
  ): void {
    if (context.kind !== 'class') {
      throw new Error('@role() decorator can only be applied to classes');
    }

    const config = getEntityMetadataFromContext(context);
    const normalizedActions = normalizeActions(actions);
    const policy = options?.policy ? { check: options.policy } : undefined;

    config.roles = config.roles || [];
    const roleDeclaration: RoleDeclaration = {
      role: roleName,
      actions: normalizedActions,
      policy,
    };

    if (options?.include) {
      roleDeclaration.includedFields = options.include.map(String);
    }
    if (options?.exclude) {
      roleDeclaration.excludedFields = options.exclude.map(String);
    }

    config.roles.push(roleDeclaration);

    if (context.metadata?.[RayfinStorageFolder]) {
      const storageConfig = getStorageFolderMetadataFromContext(context);
      storageConfig.roles = storageConfig.roles || [];
      storageConfig.roles.push(roleDeclaration);
    }
  };
}

/**
 * Shorthand decorator for authenticated role.
 *
 * Equivalent to `@role('authenticated', actions, options)`.
 * Authenticated roles require a valid user session.
 *
 * @param actions - The actions this role can perform (default: '*' for all actions)
 * @param options - Optional policy and field visibility configuration
 *
 * @example
 * ```typescript
 * @entity()
 * @authenticated('*', {
 *   policy: (claims, item) => claims.sub.eq(item.user_id),
 * })
 * export class Todo {
 *   @uuid()
 *   id!: string;
 *   @text()
 *   user_id!: string;
 * }
 * ```
 */
export function authenticated<TEntity extends object = object>(
  actions: SimpleAction | SimpleAction[] = '*',
  options?: RoleDeclarationOptions<TEntity>
): (
  target: constructor<TEntity>,
  context: ClassDecoratorContext<constructor<TEntity>>
) => void {
  return role<TEntity>('authenticated', actions, options);
}

/**
 * Shorthand decorator for the anonymous role.
 *
 * Equivalent to `@role('anonymous', actions, options)`.
 * Anonymous roles grant public access without an authenticated user session.
 *
 * @param actions - The actions this role can perform (default: '*' for all actions)
 * @param options - Optional policy and field visibility configuration
 *
 * @example
 * ```typescript
 * import { entity, anonymous, authenticated, uuid, text } from '@microsoft/rayfin-core';
 *
 * @entity()
 * @anonymous('read')   // Anonymous users can read
 * @authenticated('*')  // Authenticated users can do everything
 * export class PublicPost {
 *   @uuid() id!: string;
 *   @text() title!: string;
 * }
 * ```
 */
export function anonymous<TEntity extends object = object>(
  actions: SimpleAction | SimpleAction[] = '*',
  options?: RoleDeclarationOptions<TEntity>
): (
  target: constructor<TEntity>,
  context: ClassDecoratorContext<constructor<TEntity>>
) => void {
  return role<TEntity>('anonymous', actions, options);
}

/**
 * Base field options that are common across all field types.
 *
 * @typeParam TJSType - The TypeScript type of the field (e.g., string, number, Date)
 */
export interface BaseFieldOptions<TJSType extends Scalars> {
  /**
   * Indicates whether the field must be unique across all records.
   *
   * When set to true, a unique constraint will be created in the database
   * to enforce uniqueness for this field.
   *
   * @defaultValue false
   */
  unique?: boolean;
  /**
   * Indicates whether the field is optional (nullable).
   *
   * When set to true, the field will allow null values in the database.
   * Fields are required by default unless marked with optional: true.
   *
   * @defaultValue false (fields are required by default)
   */
  optional?: boolean;
  /**
   * The default value for the field if none is provided.
   *
   */
  default?: TJSType;
  /**
   * SQL column name to map this field to.
   *
   * When set, source-config generation uses this name instead of the property
   * name. On the connector path, use it to match an existing external table's
   * column casing or spaced names. On the data path, use it to choose the
   * generated SQL column name independently of the TypeScript property name
   * (the created column uses this name).
   */
  column?: string;
}

/**
 * Text field options for string fields.
 */
export interface TextFieldOptions extends BaseFieldOptions<string> {
  /**
   * Maximum length of the text field.
   *
   * Specifies the maximum number of characters allowed in the text field.
   * If `undefined` or `-1`, defaults to the database's maximum length for string types.
   *
   * @defaultValue undefined (database default maximum length)
   */
  max?: number;
  /** Minimum length of the text field.
   *
   * Specifies the minimum number of characters required in the text field.
   *
   * @defaultValue undefined (no minimum length)
   */
  min?: number;
  /**
   * Regular expression pattern that the text field must match.
   *
   * If provided, the text field value will be validated against this regex pattern.
   */
  regex?: RegExp;
}

/**
 * Helper function to normalize field options, mapping new option names to internal metadata names.
 * Fields are REQUIRED by default; set optional: true for nullable fields.
 */
function normalizeFieldOptions<T extends Scalars>(
  options: BaseFieldOptions<T>
): Partial<FieldMetadata<any>> {
  const normalized: Partial<FieldMetadata<any>> = { ...options };

  // Map new option names to internal metadata names
  if (options.unique !== undefined) {
    normalized.isUnique = options.unique;
    delete (normalized as Record<string, unknown>).unique;
  }

  if (options.optional !== undefined) {
    normalized.isOptional = options.optional;
    delete (normalized as Record<string, unknown>).optional;
  } else {
    // Fields are required by default
    normalized.isOptional = false;
  }

  if (options.column !== undefined) {
    normalized.columnName = options.column;
    delete (normalized as Record<string, unknown>).column;
  }

  return normalized;
}

/**
 * Text field decorator for long text content.
 *
 * Specifies a field as text type, mapping to database text types
 * (NVARCHAR(MAX), TEXT, etc. depending on dialect).
 *
 * Fields are required by default. Use `{ optional: true }` for nullable fields.
 *
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;
 *
 *   @text()
 *   title!: string;           // Required text field (default)
 *
 *   @text({ optional: true })
 *   description?: string;     // Optional text field
 *
 *   @text({ unique: true })
 *   slug!: string;            // Unique and required text field
 * }
 * ```
 *
 * @param options - Text field configuration options.
 * @returns A class field decorator.
 */
export function text(options: TextFieldOptions = {}) {
  return function <T>(
    _: T,
    context: ClassFieldDecoratorContext<unknown, string | undefined>
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    const normalized = normalizeFieldOptions(options);
    const fieldMetadata: Partial<FieldMetadata<'string'>> = {
      ...normalized,
      format: FieldFormat.Text,
      jsType: 'string',
      isSystemType: false,
    };

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}

/**
 * UUID field options for unique identifier fields.
 */
export interface UUIDFieldOptions extends BaseFieldOptions<string> {}

/**
 * UUID field decorator for unique identifiers.
 *
 * Specifies a field as UUID/GUID type, mapping to database UUID types
 * (UNIQUEIDENTIFIER, UUID, etc. depending on dialect).
 *
 * Fields are required by default. Use `{ optional: true }` for nullable fields.
 * Fields named `id` are automatically inferred as primary keys. Use `{ unique: true }` for unique constraint.
 *
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;              // UUID primary key (required by default)
 *
 *   @uuid()
 *   userId!: string;          // UUID foreign key (required by default)
 *
 *   @uuid({ optional: true })
 *   optionalId?: string;      // Optional UUID field
 *
 *   @text()
 *   title!: string;
 * }
 * ```
 *
 * @param options - UUID field configuration options.
 * @returns A class field decorator.
 */
export function uuid(options: UUIDFieldOptions = {}) {
  return function <T>(
    _: T,
    context: ClassFieldDecoratorContext<unknown, string | undefined>
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    const normalized = normalizeFieldOptions(options);
    const fieldMetadata: Partial<FieldMetadata<'string'>> = {
      ...normalized,
      format: FieldFormat.Uuid,
      jsType: 'string',
      isSystemType: false,
    };

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}

/**
 * Integer field options for whole number fields.
 */
export interface IntFieldOptions extends BaseFieldOptions<number> {
  /**
   * Maximum value for the integer field.
   */
  max?: number;
  /**
   * Minimum value for the integer field.
   */
  min?: number;
}

/**
 * Integer field decorator for whole numbers.
 *
 * Specifies a field as integer type, mapping to database integer types
 * (INT, INTEGER, etc. depending on dialect).
 *
 * Fields are required by default. Use `{ optional: true }` for nullable fields.
 *
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;
 *
 *   @int()
 *   priority!: number;        // Integer field (required by default)
 *
 *   @int({ optional: true })
 *   order?: number;           // Optional integer field
 * }
 * ```
 *
 * @param options - Integer field configuration options.
 * @returns A class field decorator.
 */
export function int(options: IntFieldOptions = {}) {
  return function <T>(
    _: T,
    context: ClassFieldDecoratorContext<unknown, number | undefined>
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    const normalized = normalizeFieldOptions(options);
    const fieldMetadata: Partial<FieldMetadata<'number'>> = {
      ...normalized,
      format: FieldFormat.Int,
      jsType: 'number',
      isSystemType: false,
    };

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}

/**
 * Decimal field options for precise numeric values.
 */
export interface DecimalFieldOptions extends BaseFieldOptions<number> {
  /**
   * Maximum value for the decimal field.
   */
  max?: number;
  /**
   * Minimum value for the decimal field.
   */
  min?: number;
  /**
   * Total number of digits (before and after the decimal point).
   *
   * Must be defined together with `scale`.
   * If omitted, defaults to 18.
   * Maximum precision is 28, limited by the Data API Builder runtime.
   */
  precision?: number;
  /**
   * Number of digits after the decimal point.
   *
   * Must be defined together with `precision`.
   * If omitted, defaults to 2.
   * Must be between 0 and `precision` (inclusive).
   */
  scale?: number;
}

/**
 * Decimal field decorator for precise numeric values.
 *
 * Specifies a field as decimal/numeric type, mapping to database decimal types
 * (DECIMAL, NUMERIC, etc. depending on dialect).
 * Useful for monetary values and precise numeric calculations.
 *
 * When no `precision` or `scale` is specified, defaults to `DECIMAL(18,2)`
 * on MSSQL and `NUMERIC(18,2)` on PostgreSQL.
 * If either `precision` or `scale` is provided, both must be specified.
 *
 * Fields are required by default. Use `{ optional: true }` for nullable fields.
 *
 * @example
 * ```typescript
 * @entity()
 * export class Product {
 *   @uuid()
 *   id!: string;
 *
 *   @decimal()
 *   price!: number;           // DECIMAL(18,2) by default
 *
 *   @decimal({ precision: 10, scale: 4 })
 *   weight!: number;          // DECIMAL(10,4)
 *
 *   @decimal({ optional: true })
 *   discount?: number;        // Optional decimal field
 * }
 * ```
 *
 * @param options - Decimal field configuration options.
 * @returns A class field decorator.
 */
export function decimal(options: DecimalFieldOptions = {}) {
  return function <T>(
    _: T,
    context: ClassFieldDecoratorContext<unknown, number | undefined>
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    const normalized = normalizeFieldOptions(options);
    const fieldMetadata: Partial<FieldMetadata<'number'>> = {
      ...normalized,
      format: FieldFormat.Decimal,
      jsType: 'number',
      isSystemType: false,
    };

    if (options.precision !== undefined) {
      fieldMetadata.precision = options.precision;
    }
    if (options.scale !== undefined) {
      fieldMetadata.scale = options.scale;
    }

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}

/**
 * Email field decorator for email addresses.
 *
 * Specifies a field as email type, mapping to database string types
 * with email format validation hints.
 *
 * The regex pattern is similar to RFC 5322, but has some extra restrictions
 * to catch common mistakes. If you need full UTF-8 support or less strict validation,
 * use a text() field with a custom regex.
 *
 * The format hint can be used for validation and UI rendering.
 * Fields are required by default. Use `{ optional: true }` for nullable fields.
 *
 * @example
 * ```typescript
 * @entity()
 * export class User {
 *   @uuid()
 *   id!: string;
 *
 *   @email({ unique: true })
 *   emailAddress!: string;    // Email field with unique constraint (required by default)
 *
 *   @text()
 *   name!: string;
 * }
 * ```
 *
 * @param options - Email field configuration options.
 * @returns A class field decorator.
 */
export function email(options: TextFieldOptions = {}) {
  return function <T>(
    _: T,
    context: ClassFieldDecoratorContext<unknown, string | undefined>
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    // RFC 5321: max email length is 320 (64 local-part + 1 @ + 255 domain)
    const emailOptions = { max: 320, ...options };
    const normalized = normalizeFieldOptions(emailOptions);
    const fieldMetadata: Partial<FieldMetadata<'string'>> = {
      ...normalized,
      regex: EMAIL_REGEX,
      format: FieldFormat.Email,
      jsType: 'string',
      isSystemType: false,
    };

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}

/**
 * Boolean field options for true/false values.
 */
export interface BooleanFieldOptions extends BaseFieldOptions<boolean> {}

/**
 * Boolean field decorator for true/false values.
 *
 * Specifies a field as boolean type, mapping to database boolean types
 * (BIT, BOOLEAN, etc. depending on dialect).
 *
 * Fields are required by default. Use `{ optional: true }` for nullable fields.
 *
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;
 *
 *   @text()
 *   title!: string;
 *
 *   @boolean()
 *   isCompleted!: boolean;    // Boolean field (required by default)
 *
 *   @boolean({ optional: true })
 *   isArchived?: boolean;     // Optional boolean field
 * }
 * ```
 *
 * @param options - Boolean field configuration options.
 * @returns A class field decorator.
 */
export function boolean(options: BooleanFieldOptions = {}) {
  return function <T>(
    _: T,
    context: ClassFieldDecoratorContext<unknown, boolean | undefined>
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    const normalized = normalizeFieldOptions(options);
    const fieldMetadata: Partial<FieldMetadata<'boolean'>> = {
      ...normalized,
      format: FieldFormat.Boolean,
      jsType: 'boolean',
      isSystemType: false,
    };

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}

/**
 * Options for the {@link set} field decorator, which constrains a string field
 * to a fixed set of allowed values.
 *
 * @typeParam T - The tuple of allowed string-literal values.
 */
export interface SetFieldOptions<
  T extends [string, ...string[]],
> extends BaseFieldOptions<T[number]> {
  /** The array of allowed string values for the field. */
  enum: T;
}

/**
 * Set field decorator for constrained string values.
 *
 * Specifies a field as an set (or enum-like) type with a limited set of allowed values.
 * Maps to database string types (NVARCHAR, VARCHAR, etc.) with check constraints.
 * The set values should match the TypeScript union type annotation.
 *
 * @param values - Array of allowed string values (must have at least one value)
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;
 *
 *   @text()
 *   title!: string;
 *
 *   @set('low', 'medium', 'high')
 *   priority!: 'low' | 'medium' | 'high';  // Enum field with check constraint
 *
 *   @set({ optional: true }, 'pending', 'completed')
 *   status?: 'pending' | 'completed';      // Optional enum field
 * }
 * ```
 */
export function set<T extends [string, ...string[]]>(
  ...values: T
): (
  target: unknown,
  context: ClassFieldDecoratorContext<unknown, T[number] | undefined>
) => void;
/**
 * Set field decorator for constrained string values (options-only overload).
 *
 * Pass an options object whose `enum` field carries the allowed values. Use
 * this overload when you want to declare options (`optional`, `default`,
 * etc.) and the enum together in a single object.
 *
 * @param options - Options object including the `enum` array of allowed values.
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;
 *
 *   @set({ enum: ['low', 'medium', 'high'] })
 *   priority!: 'low' | 'medium' | 'high';  // Required enum field
 *
 *   @set({ enum: ['pending', 'completed'], optional: true })
 *   status?: 'pending' | 'completed';      // Optional enum field
 * }
 * ```
 */
// eslint-disable-next-line no-redeclare
export function set<T extends [string, ...string[]]>(
  options: SetFieldOptions<T>
): (
  target: unknown,
  context: ClassFieldDecoratorContext<unknown, T[number] | undefined>
) => void;
/**
 * Set field decorator for constrained string values (options + positional values overload).
 *
 * Pass an options object (without `enum`) followed by positional values. Use
 * this overload when you want to declare options like `optional` alongside
 * the values without nesting the enum in the options object.
 *
 * @param options - Options object (must omit `enum`; values are passed positionally).
 * @param values - Positional allowed string values (at least one).
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;
 *
 *   @set({}, 'low', 'medium', 'high')
 *   priority!: 'low' | 'medium' | 'high';  // Required enum using positional values
 *
 *   @set({ optional: true }, 'pending', 'completed')
 *   status?: 'pending' | 'completed';      // Optional enum field
 *
 *   @set({ default: 'low' }, 'low', 'medium', 'high')
 *   defaultPriority!: 'low' | 'medium' | 'high';  // Required enum with default
 * }
 * ```
 */
// eslint-disable-next-line no-redeclare
export function set<T extends [string, ...string[]]>(
  options: Omit<SetFieldOptions<T>, 'enum'>,
  ...values: T
): (
  target: unknown,
  context: ClassFieldDecoratorContext<unknown, T[number] | undefined>
) => void;
// eslint-disable-next-line no-redeclare
export function set<T extends [string, ...string[]]>(...args: unknown[]) {
  let options: Partial<SetFieldOptions<T>> = {};

  const first = args[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    options = args.shift() as Partial<SetFieldOptions<T>>;
  }

  if (args.length > 0) {
    // Positional args take precedence; TypeScript prevents both being provided simultaneously
    options.enum = args as T;
  }

  // If no enum values were provided, use an empty array so the schema analyzer
  // can catch and report the error alongside any other validation errors.
  if (!options.enum || options.enum.length === 0) {
    options.enum = [] as unknown as T;
  }

  // Duplicate value checking is deferred to the schema analyzer so it is
  // reported together with all other validation errors.

  return function (
    _: unknown,
    context: ClassFieldDecoratorContext<unknown, T[number] | undefined>
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    const normalized = normalizeFieldOptions(options as BaseFieldOptions<any>);
    const fieldMetadata: Partial<FieldMetadata<any>> = {
      ...normalized,
      enum: options.enum, // Preserve the enum values
      format: FieldFormat.Text,
      jsType: 'string',
      isSystemType: false,
    };

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}

/**
 * Date field options for temporal values.
 */
export interface DateFieldOptions extends BaseFieldOptions<Date> {
  // TODO: add min/max options for date range?
}

/**
 * Date/datetime field decorator for temporal values.
 *
 * Specifies a field as date type, mapping to database datetime types
 * (DATETIME2, TIMESTAMP, etc. depending on dialect).
 *
 * Fields are required by default. Use `{ optional: true }` for nullable fields.
 *
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;
 *
 *   @text()
 *   title!: string;
 *
 *   @date()
 *   createdAt!: Date;         // Date field (required by default)
 *
 *   @date({ optional: true })
 *   dueDate?: Date;           // Optional date field
 * }
 * ```
 *
 * @param options - Date field configuration options.
 * @returns A class field decorator.
 */
export function date(options: DateFieldOptions = {}) {
  return function <T>(
    _: T,
    context: ClassFieldDecoratorContext<unknown, Date | undefined>
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    const normalized = normalizeFieldOptions(options);
    const fieldMetadata: Partial<FieldMetadata<'Date'>> = {
      ...normalized,
      format: FieldFormat.Date,
      jsType: 'Date',
      isSystemType: false,
    };

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}

/**
 * Options common to every entity relationship.
 */
export interface RelationshipFieldOptions extends Omit<
  BaseFieldOptions<any>,
  'default' | 'column'
> {}

/**
 * Relationship options that additionally allow explicit foreign-key columns.
 * Offered only when the relationship target declares its own primary key.
 */
export interface CustomKeyRelationshipFieldOptions<
  TTarget = object,
> extends RelationshipFieldOptions {
  /**
   * Property names on the source (host) entity that form the foreign key.
   *
   * Pair with `targetFields` of matching length for composite keys.
   */
  sourceFields?: string[];
  /**
   * Property names on the target entity that the foreign key references.
   *
   * Pair with `sourceFields` of matching length for composite keys.
   */
  targetFields?: Array<Extract<keyof TTarget, string>>;
}

/**
 * Relationship options for a data-path target (one that does not extend
 * `Source`). `sourceFields` / `targetFields` are custom foreign-key options
 * offered only on connector entities, so they are typed `never` here and
 * rejected even when passed via a variable or spread (where excess-property
 * checking, which only fires for fresh object literals, would not catch them).
 *
 * The descriptive alias name is intentional: TypeScript prints it in the
 * diagnostic when a data-path relationship tries to pass those options, so the
 * failure is self-explanatory and assertable by the type-safety tests.
 */
type DataPathRelationshipOptions = RelationshipFieldOptions & {
  sourceFields?: never;
  targetFields?: never;
};

/**
 * An entity class whose constructor declares an explicit primary key via the
 * static {@link RayfinPrimaryKey} brand. Custom foreign-key options are only
 * offered when the relationship target is one of these.
 *
 * @internal
 */
type CustomKeyEntityClass = EntityClass & {
  readonly [RayfinPrimaryKey]: readonly string[];
};

/**
 * Field decorator returned by {@link one}.
 *
 * @internal
 */
type OneRelationshipDecorator<U extends EntityClass> = <T>(
  _: T,
  context: ClassFieldDecoratorContext<unknown, InstanceType<U> | undefined>
) => void;

/**
 * Field decorator returned by {@link many}.
 *
 * @internal
 */
type ManyRelationshipDecorator<U extends EntityClass> = <T>(
  _: T,
  context: ClassFieldDecoratorContext<
    unknown,
    Array<InstanceType<U>> | undefined
  >
) => void;

/**
 * One-to-one or many-to-one relationship decorator.
 *
 * Marks a field as a relationship to a single entity instance.
 * Automatically generates a foreign key column (e.g., `category_id` for a `category` field).
 * The target entity type should be specified in the TypeScript type annotation.
 *
 * @example
 * ```typescript
 * @entity()
 * export class Todo {
 *   @uuid()
 *   id!: string;
 *
 *   @text()
 *   title!: string;
 *
 *   @one(() => Category)
 *   category!: Category;     // Many-to-one: generates category_id FK
 *
 *   @one(() => User)
 *   assignee?: User;         // Optional many-to-one relationship
 * }
 * ```
 *
 * @param target - A thunk returning the related entity class.
 * @param options - Relationship field configuration options.
 * @returns A class field decorator.
 */
// A target with an explicit primary key accepts the custom foreign-key options.

export function one<U extends CustomKeyEntityClass>(
  target: () => U,
  options?: CustomKeyRelationshipFieldOptions<InstanceType<U>>
): OneRelationshipDecorator<U>;
// Any other target references the target's primary key, so the custom
// foreign-key options are not offered. The `?: never` keys reject them even
// when passed via a variable or spread (where excess-property checking, which
// only fires for fresh object literals, would not catch them).
/**
 * Declares a to-one (many-to-one) relationship to a data-path entity.
 *
 * The generated foreign key references the target's primary key; custom
 * foreign-key columns (`sourceFields` / `targetFields`) are connector-only and
 * not available here.
 *
 * @example
 * ```typescript
 * @one(() => Category) category!: Category;
 * ```
 *
 * @param target - A thunk returning the related entity class.
 * @param options - Relationship field configuration options.
 * @returns A class field decorator.
 */
// eslint-disable-next-line no-redeclare
export function one<U extends EntityClass>(
  target: () => U,
  options?: DataPathRelationshipOptions
): OneRelationshipDecorator<U>;
// eslint-disable-next-line no-redeclare
export function one<U extends EntityClass>(
  target: () => U,
  options: CustomKeyRelationshipFieldOptions<InstanceType<U>> = {}
) {
  return function <T>(
    _: T,
    context: ClassFieldDecoratorContext<unknown, InstanceType<U> | undefined>
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    const relationshipTarget = ensureRelationshipResolver(target);
    const { sourceFields, targetFields, ...rest } = options;
    const normalized = normalizeFieldOptions(rest as BaseFieldOptions<any>);
    const fieldMetadata: Partial<FieldMetadata<any>> = {
      ...normalized,
      relationship: {
        target: relationshipTarget,
        type: RelationshipTypes.one,
        ...(sourceFields ? { sourceFields: [...sourceFields] } : {}),
        ...(targetFields ? { targetFields: [...targetFields] } : {}),
      },
    };

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}

/**
 * One-to-many relationship decorator.
 *
 * Marks a field as a relationship to multiple entity instances (collection).
 * Represents the inverse side of a many-to-one relationship.
 * The target entity type should be specified as an array in the TypeScript type annotation.
 *
 * @example
 * ```typescript
 * @entity()
 * export class Category {
 *   @uuid()
 *   id!: string;
 *
 *   @text()
 *   name!: string;
 *
 *   @many(() => Todo)
 *   todos!: Todo[];          // One-to-many: reverse side of Todo.category
 * }
 *
 * @entity()
 * export class User {
 *   @uuid()
 *   id!: string;
 *
 *   @many(() => Todo)
 *   assignedTodos!: Todo[];  // One-to-many relationship
 * }
 * ```
 *
 * @param target - A thunk returning the related entity class.
 * @param options - Relationship field configuration options.
 * @returns A class field decorator.
 */
// A target with an explicit primary key accepts the custom foreign-key options.

export function many<U extends CustomKeyEntityClass>(
  target: () => U,
  options?: CustomKeyRelationshipFieldOptions<InstanceType<U>>
): ManyRelationshipDecorator<U>;
// Any other target references the target's primary key, so the custom
// foreign-key options are not offered. The `?: never` keys reject them even
// when passed via a variable or spread (where excess-property checking, which
// only fires for fresh object literals, would not catch them).
/**
 * Declares a to-many (one-to-many) relationship to a data-path entity.
 *
 * Custom foreign-key columns (`sourceFields` / `targetFields`) are
 * connector-only and not available here.
 *
 * @example
 * ```typescript
 * @many(() => Book) books?: Book[];
 * ```
 *
 * @param target - A thunk returning the related entity class.
 * @param options - Relationship field configuration options.
 * @returns A class field decorator.
 */
// eslint-disable-next-line no-redeclare
export function many<U extends EntityClass>(
  target: () => U,
  options?: DataPathRelationshipOptions
): ManyRelationshipDecorator<U>;
// eslint-disable-next-line no-redeclare
export function many<U extends EntityClass>(
  target: () => U,
  options: CustomKeyRelationshipFieldOptions<InstanceType<U>> = {}
) {
  return function <T>(
    _: T,
    context: ClassFieldDecoratorContext<
      unknown,
      Array<InstanceType<U>> | undefined
    >
  ) {
    const config = getEntityMetadataFromContext(context);
    const fieldName = context.name.toString();
    const relationshipTarget = ensureRelationshipResolver(target);
    const { sourceFields, targetFields, ...rest } = options;
    const normalized = normalizeFieldOptions(rest as BaseFieldOptions<any>);
    const fieldMetadata: Partial<FieldMetadata<any>> = {
      ...normalized,
      relationship: {
        target: relationshipTarget,
        type: RelationshipTypes.many,
        ...(sourceFields ? { sourceFields: [...sourceFields] } : {}),
        ...(targetFields ? { targetFields: [...targetFields] } : {}),
      },
    };

    config.fields[fieldName] = upsertFieldMetadata(
      config.fields[fieldName],
      fieldMetadata
    );
  };
}
