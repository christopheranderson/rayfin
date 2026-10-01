/**
 * Retry utilities for the Rayfin CLI.
 *
 * @deprecated The retry mechanism moved to
 * `@microsoft/rayfin-tools-common/_internal/utils/retry` as part of the
 * tools architecture migration (see
 * docs/rfc/rayfin-tools-architecture-migration.md). This module re-exports
 * the shared primitives so existing imports keep working; import from the
 * shared subpath directly in new code.
 */
export {
  HttpError,
  RETRY_CONFIG,
  parseRetryAfterHeader,
  withRetry,
} from '@microsoft/rayfin-tools-common/_internal/utils/retry';
