import {
  EntityClass,
  FieldFormat,
  FieldMetadata,
  FieldType,
  getEntityMetadata,
} from './schema.js';

/**
 * Constraints for a string-format field (`@text`, `@uuid`, `@email`).
 */
export interface StringConstraints {
  /** Discriminant identifying a string-format field. */
  type: 'string';
  /** Optional semantic string format. */
  format?: 'uuid' | 'email';
  /** Minimum allowed length. */
  min?: number;
  /** Maximum allowed length. */
  max?: number;
  /** Regular expression the value must match. */
  regex?: RegExp;
  /** Whether the field may be omitted. */
  optional: boolean;
}

/**
 * Constraints for a numeric-format field (`@int`, `@decimal`).
 */
export interface NumberConstraints {
  /** Discriminant identifying a numeric-format field. */
  type: 'number';
  /** The numeric format (integer or decimal). */
  format: 'int' | 'decimal';
  /** Minimum allowed value. */
  min?: number;
  /** Maximum allowed value. */
  max?: number;
  /** Total number of significant digits (decimal fields). */
  precision?: number;
  /** Number of digits to the right of the decimal point. */
  scale?: number;
  /** Whether the field may be omitted. */
  optional: boolean;
}

/**
 * Constraints for an enum field (`@set`).
 */
export interface EnumConstraints {
  /** Discriminant identifying an enum field. */
  type: 'enum';
  /** The set of allowed string values. */
  values: readonly string[];
  /** Whether the field may be omitted. */
  optional: boolean;
}

/**
 * Constraints for a boolean field (`@boolean`).
 */
export interface BooleanConstraints {
  /** Discriminant identifying a boolean field. */
  type: 'boolean';
  /** Whether the field may be omitted. */
  optional: boolean;
}

/**
 * Constraints for a date field (`@date`).
 */
export interface DateConstraints {
  /** Discriminant identifying a date field. */
  type: 'date';
  /** Whether the field may be omitted. */
  optional: boolean;
}

/**
 * Constraints for a relationship field (`@one`, `@many`).
 *
 * Relationship fields are not deeply validated by `toStandardSchema` —
 * they are accepted as-is so that callers can attach related entities
 * to form payloads without re-walking the graph.
 */
export interface RelationshipConstraints {
  /** Discriminant identifying a relationship field. */
  type: 'relationship';
  /** Whether the field may be omitted. */
  optional: boolean;
}

/**
 * Discriminated union of all constraint shapes returned by
 * {@link getFieldConstraints}.
 */
export type FieldConstraints =
  | StringConstraints
  | NumberConstraints
  | EnumConstraints
  | BooleanConstraints
  | DateConstraints
  | RelationshipConstraints;

/**
 * Translate a raw `FieldMetadata` entry into a constraint object
 * that is convenient to consume from UI code (form labels, hints, etc.).
 *
 * @param meta - The field metadata entry to translate.
 * @returns The constraint object describing the field.
 */
export function fieldMetadataToConstraints(
  meta: FieldMetadata<FieldType>
): FieldConstraints {
  const optional = meta.isOptional === true;

  if (meta.relationship) {
    return { type: 'relationship', optional };
  }

  if (meta.enum) {
    return {
      type: 'enum',
      values: meta.enum as readonly string[],
      optional,
    };
  }

  switch (meta.format) {
    case FieldFormat.Uuid:
      return {
        type: 'string',
        format: 'uuid',
        optional,
      };
    case FieldFormat.Email:
      return {
        type: 'string',
        format: 'email',
        min: meta.min,
        max: meta.max,
        regex: meta.regex,
        optional,
      };
    case FieldFormat.Text:
      return {
        type: 'string',
        min: meta.min,
        max: meta.max,
        regex: meta.regex,
        optional,
      };
    case FieldFormat.Int:
      return {
        type: 'number',
        format: 'int',
        min: meta.min,
        max: meta.max,
        optional,
      };
    case FieldFormat.Decimal:
      return {
        type: 'number',
        format: 'decimal',
        min: meta.min,
        max: meta.max,
        precision: meta.precision,
        scale: meta.scale,
        optional,
      };
    case FieldFormat.Boolean:
      return { type: 'boolean', optional };
    case FieldFormat.Date:
      return { type: 'date', optional };
    default:
      return { type: 'string', optional };
  }
}

/**
 * Look up the validation constraints declared by a decorator on a single
 * entity field. Returns `undefined` when the field does not exist.
 *
 * Useful for UI code that needs to render constraint hints (e.g., a
 * `maxLength` indicator on a text input) without taking on the cost of
 * building a full Standard Schema for the entity.
 *
 * @param entity - The entity class to inspect.
 * @param field - The name of the field whose constraints to retrieve.
 * @returns The field's constraints, or `undefined` when the field does not exist.
 */
export function getFieldConstraints<T, K extends keyof T>(
  entity: EntityClass<T>,
  field: K & string
): FieldConstraints | undefined {
  const meta = getEntityMetadata(entity as EntityClass);
  const fieldMeta = meta.fields[field as string];
  if (!fieldMeta) {
    return undefined;
  }
  return fieldMetadataToConstraints(fieldMeta);
}
