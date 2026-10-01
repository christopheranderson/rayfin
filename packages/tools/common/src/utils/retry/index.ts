/**
 * Retry primitives for Rayfin tools.
 *
 * Universal (no Node built-ins): a generic exponential-backoff wrapper, an
 * `HttpError` carrying a status code, and a `Retry-After` header parser.
 * This is the single source of truth for transient-failure retry mechanics
 * across the tools line. Product-side wrappers (e.g. apply-with-retries)
 * compose this in `common/src/services/<svc>/`; hosts and commands import
 * the mechanism from here rather than reinventing it.
 *
 * See docs/rfc/rayfin-tools-architecture.md (Rule #5, "One source of truth
 * for cross-cutting concerns").
 */

/** Default retry configuration constants. */
export const RETRY_CONFIG = {
  maxAttempts: 5,
  baseDelay: 2000, // milliseconds
} as const;

/**
 * Error with an HTTP status code attached.
 * Thrown by API helpers so retry logic can inspect the status
 * without parsing the message string.
 */
export class HttpError extends Error {
  /** Optional delay (in ms) parsed from a `Retry-After` response header. */
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    public readonly statusCode: number,
    retryAfterMs?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'HttpError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse the `Retry-After` header from an HTTP response.
 *
 * Only the **numeric-seconds** form (`Retry-After: 120`) is supported; it is
 * converted to milliseconds. The HTTP-date form
 * (`Retry-After: Wed, 30 Apr 2026 20:15:00 GMT`) is intentionally NOT parsed
 * and returns `undefined` — no Rayfin backend emits it, and `withRetry`'s
 * exponential backoff is the fallback whenever this returns `undefined`.
 *
 * @returns The delay in milliseconds, or `undefined` when the header is
 *          absent, non-numeric, or an HTTP-date.
 */
export function parseRetryAfterHeader(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  return undefined;
}

/**
 * Generic retry wrapper with exponential backoff.
 *
 * @param operation - Async function to attempt. Receives the 1-based attempt number.
 * @param options - Retry configuration.
 * @returns The value returned by a successful `operation` call.
 * @throws  The last error if all attempts are exhausted or `shouldRetry` returns false.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    label: string;
    verbose: (...args: unknown[]) => void;
    maxAttempts?: number;
    baseDelay?: number;
    /** Return false to stop retrying immediately (e.g. non-transient errors). */
    shouldRetry?: (error: Error) => boolean;
    /** Called before each retry wait. Use for user-facing logs or spinner updates. */
    onRetry?: (attempt: number, delay: number, error: Error) => void;
  }
): Promise<T> {
  const { label, verbose, shouldRetry, onRetry } = options;
  const maxAttempts = options.maxAttempts ?? RETRY_CONFIG.maxAttempts;
  const baseDelay = options.baseDelay ?? RETRY_CONFIG.baseDelay;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      verbose(`[${label}] Attempt ${attempt}/${maxAttempts}`);
      return await operation(attempt);
    } catch (error) {
      lastError = error as Error;
      verbose(`[${label}] Attempt ${attempt} failed:`, lastError.message);

      if (shouldRetry && !shouldRetry(lastError)) {
        break; // non-retryable error
      }
      if (attempt < maxAttempts) {
        const retryAfter =
          lastError instanceof HttpError ? lastError.retryAfterMs : undefined;
        let delay: number;
        if (retryAfter) {
          delay = retryAfter;
          verbose(
            `[${label}] Retry-After header found, retrying after ${delay}ms`
          );
        } else {
          delay = Math.pow(2, attempt - 1) * baseDelay;
          verbose(`[${label}] Waiting ${delay}ms before retry...`);
        }
        onRetry?.(attempt, delay, lastError);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}
