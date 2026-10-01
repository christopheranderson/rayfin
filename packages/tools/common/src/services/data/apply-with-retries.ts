import { HttpError, withRetry } from '../../utils/retry/index.js';

const RETRYABLE_HTTP_STATUS_CODES = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Options for retrying a remote database-configuration apply. */
export interface DataApplyRetryOptions {
  /** Diagnostic sink for retry details. */
  verbose?: (...args: unknown[]) => void;
  /** Called before each retry delay. */
  onRetry?: (attempt: number, delay: number, error: Error) => void;
  /** Override the default attempt count, primarily for tests. */
  maxAttempts?: number;
  /** Override the default backoff delay, primarily for tests. */
  baseDelay?: number;
}

/** Return whether a failed remote apply may succeed when repeated. */
export function isRetryableDataApplyError(error: Error): boolean {
  if (error.message.toLowerCase().includes('destructive')) {
    return false;
  }
  if (error instanceof HttpError) {
    return RETRYABLE_HTTP_STATUS_CODES.has(error.statusCode);
  }
  if (error.name === 'TimeoutError') {
    return true;
  }
  const code = findErrorCode(error);
  if (code !== undefined) {
    return TRANSIENT_NETWORK_ERROR_CODES.has(code);
  }
  return error instanceof TypeError && error.message === 'fetch failed';
}

function findErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 3 || typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') {
    return candidate.code;
  }
  return findErrorCode(candidate.cause, depth + 1);
}

/** Retry a remote database-configuration apply using the shared backoff policy. */
export function applyDataConfigWithRetries<T>(
  operation: () => Promise<T>,
  options: DataApplyRetryOptions = {}
): Promise<T> {
  return withRetry(operation, {
    label: 'data-apply',
    verbose: options.verbose ?? (() => undefined),
    shouldRetry: isRetryableDataApplyError,
    onRetry: options.onRetry,
    maxAttempts: options.maxAttempts,
    baseDelay: options.baseDelay,
  });
}
