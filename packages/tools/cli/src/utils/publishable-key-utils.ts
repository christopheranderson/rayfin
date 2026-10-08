import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { parsePublishableKeyResponse } from '@microsoft/rayfin-tools-common/_internal/external/fabric';

import { MONIKER_HEADER } from '../config/constants.js';

import { fabricFetch, throwIfNotOk } from './http-client.js';
import { withRetry } from './retry-utils.js';

/**
 * Options for {@link getPublishableKey}.
 */
export interface GetPublishableKeyOptions {
  diagnostics?: Diagnostics;
  /**
   * Pre-formatted `Authorization` header value (`Bearer <token>`) used to
   * call the Fabric `__private/publishable-key` endpoint. The caller is
   * responsible for obtaining a valid Fabric bearer (typically via
   * `ensureAuthenticated()`).
   */
  authorizationHeader: string;
  /** Optional verbose logger; defaults to a no-op. */
  verbose?: (...args: unknown[]) => void;
  /**
   * Retry label surfaced by {@link withRetry}'s logging. Defaults to
   * `'publishable-key'` so existing log expectations don't change when the
   * call moves out of `up`.
   */
  retryLabel?: string;
}

/**
 * Retrieve the deployed Rayfin item's **publishable key** from its private
 * management endpoint at `${itemEndpoint}/__private/publishable-key`.
 *
 * The endpoint may return either a bare JSON string (`"pk_…"`) or a
 * `{ publishableKey: string }` envelope; both shapes are accepted. Any
 * non-JSON body is returned trimmed as-is.
 *
 * Wrapped in {@link withRetry} so transient 5xx / network failures are
 * retried with the CLI's standard backoff policy. Shared by `rayfin up`
 * and `rayfin dev functions apply` to keep a single resolution path.
 *
 * @param itemEndpoint - Full item endpoint, e.g.
 *                       `${fabricApiBaseUrl}/workspaces/<wsId>/appBackends/<itemId>`.
 * @param itemId - Fabric Rayfin item ID. Sent in the moniker header
 *                       so the deployed item's auth layer can authorize
 *                       the call.
 * @param options - Authorization header and optional verbose logger.
 */
export async function getPublishableKey(
  itemEndpoint: string,
  itemId: string,
  options: GetPublishableKeyOptions
): Promise<string> {
  const verbose = options.verbose ?? (() => {});
  const keyUrl = `${itemEndpoint}/__private/publishable-key`;

  return withRetry(
    async () => {
      const resp = await fabricFetch(
        keyUrl,
        {
          method: 'GET',
          headers: {
            Authorization: options.authorizationHeader,
            [MONIKER_HEADER]: itemId,
          },
        },
        options.diagnostics
      );
      verbose(`[publishable-key] Response: ${resp.status} ${resp.statusText}`);
      const body = await throwIfNotOk(
        resp,
        'Could not retrieve publishable key'
      );
      verbose(
        `[publishable-key] Response body (${body.length} chars):`,
        body.substring(0, 200)
      );
      return parsePublishableKeyResponse(body) ?? body.trim();
    },
    {
      label: options.retryLabel ?? 'publishable-key',
      verbose: (...args) => {
        options.diagnostics?.debug({
          area: 'publishable-key.retry',
          message: args.map(String).join(' '),
        });
        verbose(...args);
      },
    }
  );
}
