/**
 * Serialization utilities for DAB compatibility
 *
 * DAB often returns boolean values as strings ("true"/"false") from database queries.
 * These utilities ensure proper type conversion for TypeScript clients.
 */

import {
  FieldFormat,
  RayfinEntity,
  isRayfinEntity,
  type EntityClass,
  type EntityMetadata,
  type FieldMetadata,
  type FieldType,
} from '@microsoft/rayfin-core';

import { isMinorFixesOn } from './feature-gate';

/**
 * Converts a DAB boolean value (which may be a string) to a proper TypeScript boolean
 * @param value - The boolean value from DAB, which could be boolean, string, or undefined
 * @returns A proper TypeScript boolean
 */
export function deserializeBoolean(
  value: boolean | string | undefined | null
): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return false; // Default for undefined, null, or other types
}

/**
 * Converts a DAB date value (which may be a string) to a proper Date object
 * @param value - The date value from DAB, which could be Date, string, or undefined
 * @returns A proper Date object or undefined
 */
export function deserializeDate(
  value: Date | string | undefined | null
): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/**
 * Type guard to check if a value is a DAB string boolean
 */
export function isDabStringBoolean(value: unknown): value is 'true' | 'false' {
  return typeof value === 'string' && (value === 'true' || value === 'false');
}

/**
 * Deep transform a DAB response into plain TypeScript objects.
 *
 * Two modes:
 *
 * 1. **Structure-only (no `entity` argument, default).** Walks arrays and
 *    objects and preserves `Date` instances, but **never** value-sniffs
 *    strings for booleans or dates. A `@text()` or `@set('true', 'false')`
 *    field is byte-identical on the wire to a `@date()` or `@boolean()`
 *    field — only the declared decorator type can disambiguate them, and
 *    that metadata is not available here. Callers that need a `Date` or
 *    `boolean` from a known column must convert explicitly (e.g.
 *    `new Date(row.createdAt)` or `deserializeBoolean(row.isActive)`).
 *
 * 2. **Metadata-aware (with an `entity` class argument).** Uses the
 *    decorated entity metadata to convert only `@date()` strings to `Date`
 *    instances and `@boolean()` strings to booleans. Fields declared as
 *    `@text()`, `@set()`, etc. remain strings even when their contents look
 *    like dates. Relationship fields recurse with the target entity's
 *    metadata. Invalid date strings on a `@date()` field are preserved as
 *    strings rather than becoming `Invalid Date`.
 *
 * Invalid ISO strings on a `@date()` field are preserved as strings rather
 * than becoming `Invalid Date`; callers should defend against untrusted
 * wire data since the declared type still says `Date`.
 *
 * @param data - The DAB response payload (row, list of rows, or nested shape).
 * @param entity - Optional decorated entity class produced by `@entity()`.
 *   When provided, the returned value matches the declared TypeScript
 *   types of the entity (e.g. `@date() createdAt: Date` is a real `Date`).
 */
export function deserializeDabResponse<T>(
  data: readonly unknown[],
  entity: EntityClass<T>
): T[];
// eslint-disable-next-line no-redeclare
export function deserializeDabResponse<T>(
  data: unknown,
  entity: EntityClass<T>
): T;
// eslint-disable-next-line no-redeclare
export function deserializeDabResponse<T = any>(data: unknown): T;
// eslint-disable-next-line no-redeclare
export function deserializeDabResponse(
  data: unknown,
  entity?: EntityClass<any>
): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  const minorFixesOn = isMinorFixesOn();

  if (entity && minorFixesOn) {
    return walkWithDescriptor(data, getDescriptor(entity));
  }

  if (!minorFixesOn) {
    // Pre-PR behavior: value-sniff strings for booleans and ISO dates.
    return walkLegacyValueSniffing(data);
  }

  return walkStructural(data);
}

// Pre-PR walker: coerces `"true"/"false"` strings to booleans and ISO-shaped
// strings to `Date`. Preserved unchanged behind the flag off so the GA gate
// is a strict rollback of every deserialization change in this PR.
function walkLegacyValueSniffing(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => walkLegacyValueSniffing(item));
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>
    )) {
      if (isDabStringBoolean(value)) {
        result[key] = deserializeBoolean(value);
      } else if (typeof value === 'string' && isLegacyISODateString(value)) {
        result[key] = deserializeDate(value);
      } else if (value instanceof Date) {
        result[key] = value;
      } else if (value !== null && typeof value === 'object') {
        result[key] = walkLegacyValueSniffing(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return data;
}

function isLegacyISODateString(value: string): boolean {
  const isoDatetimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
  const isoDateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;
  return (
    (isoDatetimeRegex.test(value) || isoDateOnlyRegex.test(value)) &&
    !isNaN(Date.parse(value))
  );
}

// Accept only ISO 8601 forms Rayfin emits from DAB:
//   YYYY-MM-DD
//   YYYY-MM-DDTHH:mm:ss(.SSS)?(Z | ±HH:mm)?
// Reject calendar rollovers (e.g. 2026-02-30 → Mar 2) by validating the
// requested components against a UTC `Date`, independent of the runtime TZ.
const STRICT_ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const STRICT_ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})?$/;

function parseStrictIsoDate(value: string): Date | undefined {
  const dateOnly = STRICT_ISO_DATE_ONLY.exec(value);
  if (dateOnly) {
    const y = Number(dateOnly[1]);
    const m = Number(dateOnly[2]);
    const d = Number(dateOnly[3]);
    // Use setUTCFullYear so years 0–99 are treated as literal years (Date.UTC maps them to 1900–1999).
    const check = new Date(0);
    check.setUTCFullYear(y, m - 1, d);
    check.setUTCHours(0, 0, 0, 0);
    if (Number.isNaN(check.getTime())) return undefined;
    if (
      check.getUTCFullYear() !== y ||
      check.getUTCMonth() + 1 !== m ||
      check.getUTCDate() !== d
    ) {
      return undefined;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  const dt = STRICT_ISO_DATETIME.exec(value);
  if (!dt) return undefined;
  const y = Number(dt[1]);
  const mo = Number(dt[2]);
  const d = Number(dt[3]);
  const hh = Number(dt[4]);
  const mm = Number(dt[5]);
  const ss = Number(dt[6]);
  const ms = dt[7] === undefined ? 0 : Number(dt[7]);

  // Use setUTCFullYear so years 0–99 are treated as literal years (Date.UTC maps them to 1900–1999).
  const check = new Date(0);
  check.setUTCFullYear(y, mo - 1, d);
  check.setUTCHours(hh, mm, ss, ms);
  if (Number.isNaN(check.getTime())) return undefined;
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() + 1 !== mo ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== hh ||
    check.getUTCMinutes() !== mm ||
    check.getUTCSeconds() !== ss ||
    check.getUTCMilliseconds() !== ms
  ) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function walkStructural(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => walkStructural(item));
  }

  if (data instanceof Date) {
    return data;
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(
      data as Record<string, unknown>
    )) {
      if (value instanceof Date) {
        result[key] = value;
      } else if (value !== null && typeof value === 'object') {
        result[key] = walkStructural(value);
      } else {
        // Strings (including ISO date-shaped and "true"/"false" strings),
        // numbers, booleans, null, undefined — pass through unchanged. See
        // the doc block above for why strings must NOT be coerced here.
        result[key] = value;
      }
    }

    return result;
  }

  return data;
}

/**
 * Per-entity summary of which top-level fields are `@date()` or `@boolean()`
 * and which are relationships that should recurse into a related entity's
 * descriptor.
 */
interface EntityDeserializeDescriptor {
  /** Property names whose declared format is `Date`. */
  dateFields: ReadonlySet<string>;
  /** Property names whose declared format is `Boolean`. */
  booleanFields: ReadonlySet<string>;
  /**
   * Lazy target resolvers per relationship field, keyed by property name.
   * Resolution failures (e.g. circular imports) are not cached, so callers
   * that succeed later still get metadata-aware recursion.
   */
  relations: ReadonlyMap<string, () => EntityClass<any> | undefined>;
}

// Descriptor lookups are hot on every response — cache per class so the
// metadata walk happens once and reuses across every row.
const descriptorCache = new WeakMap<
  EntityClass<any>,
  EntityDeserializeDescriptor
>();

function readEntityFields(
  entity: EntityClass<any>
): Record<string, FieldMetadata<FieldType>> | undefined {
  // Direct read: `getEntityMetadata()` materializes empty metadata on the
  // class as a side effect, which we must not do to caller-owned classes.
  const meta = entity[Symbol.metadata]?.[RayfinEntity] as
    | EntityMetadata
    | undefined;
  return meta?.fields as Record<string, FieldMetadata<FieldType>> | undefined;
}

function getDescriptor(entity: EntityClass<any>): EntityDeserializeDescriptor {
  const cached = descriptorCache.get(entity);
  if (cached) return cached;

  const dateFields = new Set<string>();
  const booleanFields = new Set<string>();
  const relations = new Map<string, () => EntityClass<any> | undefined>();

  const fields = readEntityFields(entity);

  if (fields) {
    for (const [name, meta] of Object.entries(fields)) {
      if (!meta) continue;

      if (meta.format === FieldFormat.Date) {
        dateFields.add(name);
      } else if (meta.format === FieldFormat.Boolean) {
        booleanFields.add(name);
      }

      if (meta.relationship) {
        const resolve = meta.relationship.target;
        relations.set(name, () => {
          let target: unknown;
          try {
            target = resolve();
          } catch {
            return undefined;
          }
          return target && isRayfinEntity(target) ? target : undefined;
        });
      }
    }
  }

  const descriptor: EntityDeserializeDescriptor = {
    dateFields,
    booleanFields,
    relations,
  };
  descriptorCache.set(entity, descriptor);
  return descriptor;
}

function walkWithDescriptor(
  data: unknown,
  descriptor: EntityDeserializeDescriptor
): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => walkWithDescriptor(item, descriptor));
  }

  if (data instanceof Date) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      result[key] = value;
      continue;
    }

    if (value instanceof Date) {
      result[key] = value;
      continue;
    }

    const resolveRelation = descriptor.relations.get(key);
    const relatedClass = resolveRelation?.();
    if (relatedClass) {
      const childDescriptor = getDescriptor(relatedClass);
      // DAB wraps to-many relationships as `{ items: [...], hasNextPage,
      // endCursor }`, but the entity type declares `Target[]`. Unwrap here
      // so the runtime shape matches the declared type; nested to-many
      // pagination metadata is dropped (top-level queries surface it via
      // the paginated builder API instead).
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Array.isArray((value as { items?: unknown }).items)
      ) {
        result[key] = (value as { items: unknown[] }).items.map((item) =>
          walkWithDescriptor(item, childDescriptor)
        );
      } else {
        result[key] = walkWithDescriptor(value, childDescriptor);
      }
      continue;
    }

    if (typeof value === 'string' && descriptor.dateFields.has(key)) {
      const parsed = parseStrictIsoDate(value);
      // Preserve unparseable / calendar-invalid strings (e.g. "2026-13-45"
      // or rollovers like "2026-02-30") verbatim so the caller can spot
      // bad wire data instead of getting a silently-shifted `Date`.
      result[key] = parsed ?? value;
      continue;
    }

    if (descriptor.booleanFields.has(key)) {
      if (typeof value === 'boolean') {
        result[key] = value;
      } else if (isDabStringBoolean(value)) {
        result[key] = deserializeBoolean(value);
      } else {
        // Not a recognized DAB boolean shape — preserve verbatim so callers
        // can spot bad wire data rather than getting a silent `false`.
        result[key] = value;
      }
      continue;
    }

    if (typeof value === 'object') {
      // Unmodeled nested object (e.g. an unknown DAB envelope). Fall back to
      // a structure-only walk so nothing gets silently coerced.
      result[key] = walkStructural(value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

/**
 * Transform data for sending to DAB (opposite of deserialize)
 * Converts boolean values to strings if needed for specific DAB configurations
 */
export function serializeForDab<T = any>(data: T): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => serializeForDab(item));
  }

  if (typeof data === 'object') {
    const result: any = {};

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'boolean') {
        // Keep booleans as booleans for most DAB scenarios
        // Only convert to strings if specifically needed
        result[key] = value;
      } else if (value instanceof Date) {
        // Convert Date objects to ISO strings
        result[key] = value.toISOString();
      } else if (typeof value === 'object') {
        // Recursively process nested objects
        result[key] = serializeForDab(value);
      } else {
        // Keep other values as-is
        result[key] = value;
      }
    }

    return result;
  }

  // For primitive values, return as-is
  return data;
}
