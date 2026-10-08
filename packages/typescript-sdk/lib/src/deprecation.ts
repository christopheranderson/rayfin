/**
 * Cross-environment deprecation utilities for the Rayfin SDK.
 *
 * `@microsoft/rayfin-lib` is universal: it runs in browsers, Node, and workers.
 * That rules out Node's `util.deprecate` / `process.emitWarning` (Node-only), so
 * this module provides a browser-safe equivalent inspired by `util.deprecate`.
 *
 * One shared emit path ({@link deprecate}) handles message formatting, dedupe by
 * a stable `code`, and silencing. {@link deprecateFn} and {@link deprecateField}
 * are thin call-shapes on top of it for deprecated methods and properties.
 */

/**
 * Options shared by every deprecation call-shape.
 *
 * @internal
 */
export interface DeprecateOptions {
  /**
   * Emit at most once per `code` (default `true`). When `false`, the warning
   * fires on every call and the `code` is never recorded in the dedupe set.
   */
  once?: boolean;
}

/** Codes that have already emitted a warning (used for once-per-code dedupe). */
const emittedCodes = new Set<string>();

/**
 * Programmatic silence override. `undefined` means "defer to the environment";
 * `true`/`false` force silencing on/off regardless of env.
 */
let silencedOverride: boolean | undefined;

/**
 * Defensively read an environment variable. Safe in browsers and workers where
 * `process` is undefined; never throws.
 */
function getEnv(name: string): string | undefined {
  try {
    const processLike = (
      globalThis as unknown as {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process;
    return processLike?.env?.[name];
  } catch {
    return undefined;
  }
}

/**
 * Whether deprecation warnings are currently silenced.
 *
 * Precedence: an explicit {@link setDeprecationsSilenced} override wins; otherwise
 * the `RAYFIN_NO_DEPRECATION` environment variable (`'1'` or `'true'`,
 * case-insensitive) silences; otherwise warnings are emitted.
 */
export function isDeprecationSilenced(): boolean {
  if (silencedOverride !== undefined) {
    return silencedOverride;
  }
  const envValue = getEnv('RAYFIN_NO_DEPRECATION');
  if (envValue === undefined) {
    return false;
  }
  const normalized = envValue.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * Programmatically silence or unsilence all deprecation warnings. This override
 * takes precedence over the `RAYFIN_NO_DEPRECATION` environment variable and is
 * the browser-safe way to quiet warnings.
 *
 * @param silenced - `true` to suppress all deprecation warnings, `false` to re-enable them.
 */
export function setDeprecationsSilenced(silenced: boolean): void {
  silencedOverride = silenced;
}

/** Emit via `console.warn` only when it is callable; never throws. */
function tryWarn(formatted: string): void {
  try {
    if (typeof globalThis.console?.warn === 'function') {
      globalThis.console.warn(formatted);
    }
  } catch {
    // Swallow: a deprecation notice must never break the caller.
  }
}

/**
 * Emit a `[rayfin]`-prefixed deprecation warning via `console.warn`.
 *
 * This is the consumption-site call-shape: invoke it where a deprecated config
 * field is read (detect that the consumer set it, e.g. `field !== undefined`,
 * rather than testing truthiness). {@link deprecateFn} and {@link deprecateField}
 * delegate here so formatting, dedupe, and silencing live in one place.
 *
 * @param code - Stable identifier (e.g. `RAYFIN_DEP_USE_PROXY`) used for dedupe and
 *   appended to the message so warnings are greppable/filterable.
 * @param message - Human-readable explanation of what is deprecated and the migration.
 * @param options - See {@link DeprecateOptions}.
 * @internal
 */
export function deprecate(
  code: string,
  message: string,
  options?: DeprecateOptions
): void {
  if (isDeprecationSilenced()) {
    // Do not record the code while silenced so unsilencing later still warns once.
    return;
  }
  const once = options?.once !== false;
  if (once && emittedCodes.has(code)) {
    return;
  }
  tryWarn(`[rayfin] ${message} [${code}]`);
  if (once) {
    emittedCodes.add(code);
  }
}

/**
 * Cross-environment equivalent of Node's `util.deprecate` for deprecated
 * *methods*: wraps `fn` so the warning fires when it is called, returning a
 * function with the same signature. Preserves arguments, `this`, and the return
 * value.
 *
 * @param fn - The function to wrap.
 * @param code - Stable dedupe/identification code.
 * @param message - Human-readable deprecation message.
 * @param options - See {@link DeprecateOptions}.
 * @internal
 */
export function deprecateFn<F extends (...args: never[]) => unknown>(
  fn: F,
  code: string,
  message: string,
  options?: DeprecateOptions
): F {
  const wrapped = function (
    this: unknown,
    ...args: Parameters<F>
  ): ReturnType<F> {
    deprecate(code, message, options);
    return fn.apply(this, args) as ReturnType<F>;
  };
  return wrapped as unknown as F;
}

/**
 * Redefine a deprecated property on an object/instance *you own* as an accessor
 * that warns on get and set while preserving the underlying value.
 *
 * ⚠️ Use this only for objects the SDK constructs and hands back to consumers.
 * Do not trap fields on a config bag the consumer builds: that would mutate their
 * object and make the warning depend on property access order. For deprecated
 * config fields, call {@link deprecate} at the consumption site instead.
 *
 * @param obj - The object whose property is deprecated.
 * @param key - The deprecated property key.
 * @param code - Stable dedupe/identification code.
 * @param message - Human-readable deprecation message.
 * @param options - See {@link DeprecateOptions}.
 * @internal
 */
export function deprecateField<T extends object, K extends keyof T>(
  obj: T,
  key: K,
  code: string,
  message: string,
  options?: DeprecateOptions
): void {
  let value = obj[key];
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: true,
    get(): T[K] {
      deprecate(code, message, options);
      return value;
    },
    set(next: T[K]): void {
      deprecate(code, message, options);
      value = next;
    },
  });
}

/**
 * Clear emitted-code memory and the programmatic silence override.
 *
 * Test-only helper; intentionally NOT exported from the package index. Tests
 * import it directly from this module.
 */
export function __resetDeprecationsForTesting(): void {
  emittedCodes.clear();
  silencedOverride = undefined;
}
