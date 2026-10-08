/**
 * General-purpose utility functions shared across project config consumers.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively deep-merges `updates` into `base`, returning a new object.
 *
 * - Plain objects are merged key-by-key (recursively).
 * - Arrays and primitives in `updates` replace the corresponding value in `base`.
 * - Neither input is mutated.
 */
export function deepMerge(base: unknown, updates: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(updates)) {
    return updates;
  }

  const result: Record<string, unknown> = { ...base };

  for (const [key, updateValue] of Object.entries(updates)) {
    const baseValue = result[key];

    if (isPlainObject(baseValue) && isPlainObject(updateValue)) {
      result[key] = deepMerge(baseValue, updateValue);
      continue;
    }

    result[key] = updateValue;
  }

  return result;
}
