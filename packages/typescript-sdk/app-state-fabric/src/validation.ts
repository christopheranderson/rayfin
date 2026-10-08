/**
 * State validation: what may be stored, how large, and how deeply
 * nested.
 */

import { FabricAppStateError } from './errors';
import { LAUNCH_STATE_PREFIX } from './launchState';
import type { FabricAppState } from './types';

/**
 * Default ceiling on the *encoded* state, in bytes.
 *
 * Shared links must survive corporate proxies, mail gateways, Teams, and
 * SharePoint, which commonly truncate beyond roughly 8 000 characters.
 * The canonical item path plus existing portal parameters already
 * consume several hundred, so 4 KiB of encoded state leaves headroom.
 */
export const DEFAULT_MAX_ENCODED_BYTES = 4096;

/** Default ceiling on nesting depth; the root object counts as depth 1. */
export const DEFAULT_MAX_DEPTH = 20;

/**
 * base64url expands binary by 4/3, so the raw JSON budget is three
 * quarters of the encoded budget.  Validating against the raw size lets
 * the SDK fail fast without duplicating the host's encoder.
 */
const BASE64_EXPANSION_NUMERATOR = 3;
const BASE64_EXPANSION_DENOMINATOR = 4;

/**
 * Reject values that cannot survive a JSON round trip, and enforce the
 * depth limit.
 *
 * `JSON.stringify` is not sufficient on its own: it *silently drops*
 * `undefined` and function-valued properties rather than failing, which
 * would let an app believe it saved state that never reached the URL.
 * The explicit walk also produces an actionable error path.
 *
 * @param seen - Ancestors on the current branch, used for cycle
 *   detection.  A `Set` of the current path is correct here; a global
 *   `WeakSet` would wrongly reject the same object appearing twice as
 *   siblings, which serialises fine.
 */
function assertSerializable(
  value: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  seen: Set<object>
): void {
  if (value === null) return;

  const type = typeof value;

  if (type === 'string' || type === 'boolean') return;

  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new FabricAppStateError(
        `State value at "${path}" is NaN or Infinity, which cannot be represented in JSON.`,
        'INVALID_STATE'
      );
    }
    return;
  }

  if (type === 'undefined') {
    throw new FabricAppStateError(
      `State value at "${path}" is undefined. Omit the property or use null.`,
      'INVALID_STATE'
    );
  }

  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new FabricAppStateError(
      `State value at "${path}" is of unsupported type "${type}".`,
      'INVALID_STATE'
    );
  }

  // Objects and arrays from here on.
  if (depth > maxDepth) {
    throw new FabricAppStateError(
      `State nesting exceeds the maximum depth of ${maxDepth} at "${path}".`,
      'STATE_TOO_DEEP'
    );
  }

  const obj = value as object;

  if (seen.has(obj)) {
    throw new FabricAppStateError(
      `State contains a circular reference at "${path}".`,
      'INVALID_STATE'
    );
  }

  // Dates, Maps, Sets, and class instances all survive structuredClone
  // but lose their identity through JSON, so reject them explicitly
  // rather than silently degrading them to {} or an ISO string.
  if (!Array.isArray(obj) && Object.getPrototypeOf(obj) !== Object.prototype) {
    throw new FabricAppStateError(
      `State value at "${path}" must be a plain object or array.`,
      'INVALID_STATE'
    );
  }

  seen.add(obj);

  if (Array.isArray(obj)) {
    // Indexed rather than `forEach`, which skips holes. `JSON.stringify`
    // turns a hole into `null`, so skipping one would silently change the
    // state the app believes it saved.
    for (let index = 0; index < obj.length; index++) {
      if (!(index in obj)) {
        throw new FabricAppStateError(
          `State value at "${path}[${index}]" is an empty slot in a sparse array, which JSON turns into null. Use null explicitly.`,
          'INVALID_STATE'
        );
      }

      assertSerializable(
        obj[index],
        `${path}[${index}]`,
        depth + 1,
        maxDepth,
        seen
      );
    }
  } else {
    for (const [key, item] of Object.entries(obj)) {
      assertSerializable(item, `${path}.${key}`, depth + 1, maxDepth, seen);
    }
  }

  seen.delete(obj);
}

/**
 * Validate a state object and return its serialised form.
 *
 * @internal Exported for unit tests.
 */
export function validateAppState(
  state: FabricAppState,
  maxEncodedBytes: number,
  maxDepth: number
): string {
  if (
    typeof state !== 'object' ||
    state === null ||
    Array.isArray(state) ||
    Object.getPrototypeOf(state) !== Object.prototype
  ) {
    throw new FabricAppStateError(
      'State must be a plain object.',
      'INVALID_STATE'
    );
  }

  assertSerializable(state, 'state', 1, maxDepth, new Set());

  const json = JSON.stringify(state);

  // The host measures the prefix as part of its budget, so leaving it out
  // here would pass states the host then rejects on the round trip.
  const rawBudget = Math.floor(
    ((maxEncodedBytes - LAUNCH_STATE_PREFIX.length) *
      BASE64_EXPANSION_NUMERATOR) /
      BASE64_EXPANSION_DENOMINATOR
  );
  const byteLength = new TextEncoder().encode(json).length;

  if (byteLength > rawBudget) {
    throw new FabricAppStateError(
      `State is ${byteLength} bytes, which exceeds the ${rawBudget}-byte limit ` +
        `(${maxEncodedBytes} bytes once encoded). Store large state server-side ` +
        `and put an identifier in the URL instead.`,
      'STATE_TOO_LARGE'
    );
  }

  return json;
}
