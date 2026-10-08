import type { StandardSchemaV1 } from '@standard-schema/spec';

import {
  EntityClass,
  FieldFormat,
  FieldMetadata,
  FieldType,
  getEntityMetadata,
  type PrimaryKeyField,
} from './schema.js';

/**
 * A Standard Schema validator with a convenience `validate()` method.
 *
 * - Pass the object to any Standard Schema-compatible library (TanStack Form,
 *   Conform, tRPC v11, etc.) — they read `~standard`.
 * - Call `.validate(value)` directly from your own form code.
 */
export interface RayfinStandardSchema<I, O = I> extends StandardSchemaV1<I, O> {
  /**
   * Validates a value against the schema.
   *
   * @param value - The value to validate.
   * @returns An object with the parsed `value` on success, or `issues` describing validation failures.
   */
  validate(
    value: unknown
  ):
    | { value: O; issues?: undefined }
    | { value?: undefined; issues: readonly StandardSchemaV1.Issue[] };
}

/**
 * Build a [Standard Schema](https://standardschema.dev) validator for an
 * entity class declared with the Rayfin decorators (`@entity`, `@text`,
 * `@uuid`, `@int`, `@boolean`, `@set`, …).
 *
 * The returned object implements the `~standard` contract and can be passed
 * to any Standard Schema-compatible library. It also exposes a convenience
 * `.validate()` method so form code doesn't need `['~standard'].validate()`.
 *
 * The primary key field (`id`) is **automatically omitted** — form schemas
 * never validate server-generated IDs. Pass additional field names via
 * `omit` for other server-managed fields like timestamps.
 *
 * @example
 * ```ts
 * import { toStandardSchema } from '@microsoft/rayfin-core';
 * import { Todo } from '../rayfin/data/Todo.js';
 *
 * // id is auto-omitted — only list additional fields to exclude
 * const todoInput = toStandardSchema(Todo, {
 *   omit: ['createdAt', 'updatedAt'] as const,
 * });
 *
 * const result = todoInput.validate(formValues);
 * if (result.issues) {
 *   // show errors keyed by issue.path[0]
 * } else {
 *   await api.createTodo(result.value);
 * }
 * ```
 *
 * @param entity - Entity class decorated with `@entity()`.
 * @param options - Optional configuration.
 *   - `omit`: Field names to exclude from the schema (in addition to `id`).
 *     The validated value type is narrowed to `Omit<T, K | 'id'>`. Omitted
 *     fields are also rejected as unknown if they appear in the input. The
 *     `K extends keyof T` constraint catches typos at compile time.
 */
export function toStandardSchema<T, K extends keyof T = never>(
  entity: EntityClass<T>,
  options?: { omit?: readonly K[] }
): RayfinStandardSchema<Omit<T, K | (PrimaryKeyField & keyof T)>> {
  const entityMeta = getEntityMetadata(entity as EntityClass);
  const omit = new Set<string>([
    'id',
    ...((options?.omit ?? []) as readonly string[]),
  ]);

  type V = Omit<T, K | (PrimaryKeyField & keyof T)>;
  type Result =
    | { value: V; issues?: undefined }
    | { value?: undefined; issues: readonly StandardSchemaV1.Issue[] };

  const validateFn = (value: unknown): Result =>
    validate(entityMeta.fields, omit, value) as Result;

  return {
    '~standard': {
      version: 1,
      vendor: 'rayfin',
      validate: validateFn,
    },
    validate: validateFn,
  };
}

interface ValidationResult {
  value?: unknown;
  issues?: StandardSchemaV1.Issue[];
}

function validate(
  fields: Record<string, FieldMetadata<FieldType>>,
  omit: Set<string>,
  value: unknown
): ValidationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      issues: [{ message: 'Expected an object', path: [] }],
    };
  }

  const input = value as Record<string, unknown>;
  const issues: StandardSchemaV1.Issue[] = [];
  const output: Record<string, unknown> = {};

  // Reject unknown / omitted keys.
  for (const key of Object.keys(input)) {
    if (omit.has(key)) {
      issues.push({
        message: `Field '${key}' is omitted from this schema`,
        path: [key],
      });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      issues.push({
        message: `Unknown field '${key}'`,
        path: [key],
      });
    }
  }

  // Validate each known, non-omitted field.
  for (const [name, meta] of Object.entries(fields)) {
    if (omit.has(name)) continue;

    // Relationship fields (@one, @many) are navigation properties — they are
    // never part of a form payload. Skip them automatically so callers don't
    // need to list every relationship in `omit`.
    if (meta.relationship) continue;

    const has = Object.prototype.hasOwnProperty.call(input, name);
    const fieldValue = has ? input[name] : undefined;

    // Required-but-missing.
    if (!has || fieldValue === undefined || fieldValue === null) {
      if (meta.default !== undefined) {
        // Field has a declared default — inject it automatically.
        output[name] = meta.default;
        continue;
      }
      if (meta.isOptional) {
        // Skip — optional and absent.
        continue;
      }
      issues.push({
        message: `Field '${name}' is required`,
        path: [name],
      });
      continue;
    }

    const fieldIssues = validateField(name, meta, fieldValue);
    if (fieldIssues.length > 0) {
      issues.push(...fieldIssues);
      continue;
    }
    output[name] = fieldValue;
  }

  if (issues.length > 0) {
    return { issues };
  }
  return { value: output };
}

function validateField(
  name: string,
  meta: FieldMetadata<FieldType>,
  value: unknown
): StandardSchemaV1.Issue[] {
  // Relationship fields are accepted as-is; the related entity is not
  // re-validated here. Form code typically attaches a previously-fetched
  // entity reference, not raw input that needs deep validation.
  if (meta.relationship) {
    return [];
  }

  if (meta.enum) {
    const values = meta.enum as readonly unknown[];
    if (!values.includes(value)) {
      return [
        {
          message: `Field '${name}' must be one of: ${values.join(', ')}`,
          path: [name],
        },
      ];
    }
    return [];
  }

  switch (meta.format) {
    case FieldFormat.Uuid:
      return validateUuid(name, value);
    case FieldFormat.Email:
      return validateEmail(name, meta, value);
    case FieldFormat.Text:
      return validateText(name, meta, value);
    case FieldFormat.Int:
      return validateInt(name, meta, value);
    case FieldFormat.Decimal:
      return validateDecimal(name, meta, value);
    case FieldFormat.Boolean:
      return typeof value === 'boolean'
        ? []
        : [{ message: `Field '${name}' must be a boolean`, path: [name] }];
    case FieldFormat.Date:
      return validateDate(name, value);
    default:
      return [];
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(name: string, value: unknown): StandardSchemaV1.Issue[] {
  if (typeof value !== 'string') {
    return [{ message: `Field '${name}' must be a string`, path: [name] }];
  }
  if (!UUID_REGEX.test(value)) {
    return [{ message: `Field '${name}' must be a valid UUID`, path: [name] }];
  }
  return [];
}

// Practical email check — same shape as HTML5 input[type=email].
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(
  name: string,
  meta: FieldMetadata<FieldType>,
  value: unknown
): StandardSchemaV1.Issue[] {
  const issues = validateText(name, meta, value);
  if (issues.length > 0) return issues;
  if (typeof value === 'string') {
    // Guard against ReDoS: reject absurdly long inputs before running the
    // regex. The IETF specification for SMTP (RFC 5321) limits the total
    // email path to 256 chars; 1000 is generous.
    if (value.length > 1000 || !EMAIL_REGEX.test(value)) {
      return [
        { message: `Field '${name}' must be a valid email`, path: [name] },
      ];
    }
  }
  return [];
}

function validateText(
  name: string,
  meta: FieldMetadata<FieldType>,
  value: unknown
): StandardSchemaV1.Issue[] {
  if (typeof value !== 'string') {
    return [{ message: `Field '${name}' must be a string`, path: [name] }];
  }
  const issues: StandardSchemaV1.Issue[] = [];
  if (meta.min !== undefined && value.length < meta.min) {
    issues.push({
      message: `Field '${name}' must be at least ${meta.min} character(s)`,
      path: [name],
    });
  }
  if (meta.max !== undefined && meta.max >= 0 && value.length > meta.max) {
    issues.push({
      message: `Field '${name}' must be at most ${meta.max} character(s)`,
      path: [name],
    });
  }
  if (meta.regex && !meta.regex.test(value)) {
    issues.push({
      message: `Field '${name}' does not match required pattern`,
      path: [name],
    });
  }
  return issues;
}

function validateInt(
  name: string,
  meta: FieldMetadata<FieldType>,
  value: unknown
): StandardSchemaV1.Issue[] {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [{ message: `Field '${name}' must be a number`, path: [name] }];
  }
  if (!Number.isInteger(value)) {
    return [{ message: `Field '${name}' must be an integer`, path: [name] }];
  }
  return checkNumericBounds(name, meta, value);
}

function validateDecimal(
  name: string,
  meta: FieldMetadata<FieldType>,
  value: unknown
): StandardSchemaV1.Issue[] {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [{ message: `Field '${name}' must be a number`, path: [name] }];
  }
  return checkNumericBounds(name, meta, value);
}

function checkNumericBounds(
  name: string,
  meta: FieldMetadata<FieldType>,
  value: number
): StandardSchemaV1.Issue[] {
  const issues: StandardSchemaV1.Issue[] = [];
  if (meta.min !== undefined && value < meta.min) {
    issues.push({
      message: `Field '${name}' must be >= ${meta.min}`,
      path: [name],
    });
  }
  if (meta.max !== undefined && value > meta.max) {
    issues.push({
      message: `Field '${name}' must be <= ${meta.max}`,
      path: [name],
    });
  }
  return issues;
}

function validateDate(name: string, value: unknown): StandardSchemaV1.Issue[] {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [];
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return [];
  }
  return [{ message: `Field '${name}' must be a valid date`, path: [name] }];
}
