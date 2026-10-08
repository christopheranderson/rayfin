import type { Diagnostics } from '../../adapters/index.js';
import type { Http } from '../../adapters/index.js';

/** HTTP verbs accepted by {@link FabricHttpClient.request}. */
export type FabricHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Construction options for a {@link FabricHttpClient}. */
export interface FabricHttpClientOptions {
  /**
   * Authed transport. The host's `Http` implementation is responsible for
   * attaching the Fabric bearer token — the client never sets `Authorization`
   * itself.
   */
  http: Http;
  /**
   * Fabric REST API base URL, e.g. `https://api.fabric.microsoft.com/v1`.
   * Resolved by the host (from `getFabricSettings()`) and passed in so the
   * universal client stays free of environment/config concerns.
   */
  baseUrl: string;
  /**
   * Optional verbose sink. Defaults to a silent implementation so the client
   * never writes to the console.
   */
  diagnostics?: Diagnostics;
  /**
   * Default cancellation signal for every request issued by this transport.
   * Individual request options may override it.
   */
  signal?: AbortSignal;
}

/** Per-request options for {@link FabricHttpClient} calls. */
export interface FabricRequestOptions {
  /**
   * Cancellation signal. Threaded into the underlying `fetch` so that, when
   * aborted, the in-flight request rejects with the signal's abort reason
   * instead of continuing to contact Fabric after the caller has moved on.
   */
  signal?: AbortSignal;
}

/**
 * A started Fabric long-running operation, with everything needed to poll it.
 *
 * Returned by {@link FabricHttpClient.startOperation}, which enforces that
 * Fabric supplied both ids, so a poll loop can use them without re-checking.
 * Fabric's other `202 Accepted` — workspace capacity assignment — carries no
 * operation and is confirmed by re-reading the workspace instead; that call
 * uses {@link FabricHttpClient.requestAccepted} and yields nothing.
 */
export interface FabricPollableOperation {
  operationId: string;
  operationLocation: string;
  /** Service pacing hint for the first poll, in milliseconds. */
  retryAfterMs?: number;
}

/** Metadata returned by an accepted request whose completion is observed elsewhere. */
export interface FabricAcceptedResponse {
  /** Service pacing hint for the first completion check, in milliseconds. */
  retryAfterMs?: number;
}
