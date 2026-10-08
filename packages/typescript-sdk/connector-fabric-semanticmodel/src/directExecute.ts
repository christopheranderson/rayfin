/**
 * Direct Power BI execution path for the `fabric-semanticmodel` connector.
 *
 * Used only by the CLI branch of the invoke middleware (see `./runtime`). In
 * the Rayfin CLI inner loop there is no deployed app, so the BaaS → User Data
 * Function → connector chain the standalone transport relies on does not
 * exist. This module calls the **public** Power BI DAX endpoints instead, under
 * the developer's own identity.
 *
 * The endpoint is deliberately the public one rather than any internal variant:
 * at design time the developer is *authoring*, so gating on the model's Build
 * permission is the correct behaviour.
 *
 * Auth is never handled here. The caller passes the pre-authenticated
 * {@link InvokeHttpClient} supplied by the connectors layer, which injects the
 * bearer token and reuses the SDK's token-refresh behaviour.
 *
 * **These functions never throw.** Every failure, whether a non-2xx response, a
 * socket that never connected, or a corrupt Arrow stream, comes back as a
 * failed envelope. This is the contract Lyra's `DaxExecutor` established, and
 * it is
 * what lets a caller write one `toQueryResult` branch instead of wrapping every
 * call in a try/catch.
 */

import type { InvokeHttpClient } from '@microsoft/rayfin-connectors';

import { parseArrowStream } from './arrow';
import {
  DEFAULT_POWER_BI_BASE_URL,
  derivePowerBiBaseUrl,
  type FabricEndpoints,
} from './endpoints';
import type {
  FabricSemanticModelTabularResponse,
  QueryErrorCategory,
} from './types';

/**
 * The semantic model a direct call targets.
 *
 * On the standalone path the BaaS host injects the target server-side from
 * `rayfin.yml`, so the Builder never sends it on the wire. The CLI path has no
 * host to do that injection and the SDK's `ConnectorConfig` intentionally
 * carries only *which* connector is used, not *how* to reach it, so the
 * target is supplied to `fabricSemanticModel` when the runtime is constructed.
 */
export interface FabricSemanticModelTarget {
  /**
   * Fabric workspace id, or the literal `'me'` for My Workspace (which uses a
   * different URL shape with no `/groups` segment).
   */
  workspaceId: string;
  /** Semantic model (dataset) item id. */
  itemId: string;
}

/**
 * Per-query options accepted by the Power BI `executeDaxQueries` endpoint.
 */
export interface DaxQueryOptions {
  /** Culture for the query, e.g. `'en-US'`. Affects formatting and collation. */
  culture?: string;
  /** Return only the column schema, no rows. Useful for cheap validation. */
  schemaOnly?: boolean;
  /** Query timeout in seconds. */
  queryTimeout?: number;
  /**
   * Cap the number of rows Analysis Services returns.
   *
   * Capping on the request keeps the payload small *in transit* rather than
   * trimming it after the fact, which matters when an agent validates a query
   * that would otherwise return hundreds of thousands of rows. When the cap
   * truncates a result Power BI reports it as a per-table error, which
   * `toQueryResult` categorises as `'overflow'`, so a truncated result is
   * never mistaken for a complete one.
   */
  resultSetRowCountLimit?: number;
}

/**
 * Options for the semantic-model connector runtime.
 */
export interface FabricSemanticModelRuntimeOptions extends DaxQueryOptions {
  /**
   * The semantic model the CLI path should query, or a resolver returning it.
   * A resolver lets the target come from configuration that is only known once
   * the process is running (an env var, a selected model, and so on).
   *
   * When this is omitted, or the resolver returns `undefined`, the CLI branch
   * has no target and delegates to the standalone transport instead.
   */
  target?:
    | FabricSemanticModelTarget
    | (() => FabricSemanticModelTarget | undefined);
  /**
   * Override the Power BI REST base URL. Takes precedence over
   * {@link FabricSemanticModelRuntimeOptions.endpoints}. Defaults to
   * {@link DEFAULT_POWER_BI_BASE_URL}.
   */
  baseUrl?: string;
  /**
   * Environment endpoints to derive the Power BI base URL from, for sovereign
   * clouds and pre-production rings. Ignored when `baseUrl` is set.
   */
  endpoints?: FabricEndpoints;
  /**
   * Supply the bearer token for the direct CLI path.
   *
   * The connectors layer's `ctx.http` authenticates with a Rayfin-audience
   * token, but the Power BI endpoint this path calls requires the
   * `https://analysis.windows.net/powerbi/api` audience, and there is no way to
   * select an audience on `ctx.http`. Returning a token here sets `Authorization`
   * explicitly, which wins because `ApiClient.prepareHeaders` only injects its
   * own token when the header is absent.
   *
   * Optional, so existing callers keep working. Without it the request is still
   * built and sent correctly, and Power BI answers 401 or 403.
   *
   * Only the CLI path reads this. Non-CLI hosts delegate before reaching it and
   * keep the Rayfin token, so the two audiences cannot collide.
   *
   * May return a promise, since acquiring a token usually means an async call
   * to a credential provider. A returned value that already carries the
   * `Bearer` scheme is passed through unchanged.
   */
  getToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * Session-scoped activity id sent as the `activityid` header, correlating
   * every request from one runtime in service-side telemetry.
   */
  sessionId?: string;
}

/** Resolve the configured target, tolerating both a value and a resolver. */
export function resolveTarget(
  target: FabricSemanticModelRuntimeOptions['target']
): FabricSemanticModelTarget | undefined {
  const resolved = typeof target === 'function' ? target() : target;
  if (!resolved?.workspaceId || !resolved.itemId) {
    return undefined;
  }
  return resolved;
}

/** Resolve the Power BI base URL from the two ways it can be configured. */
export function resolveBaseUrl(
  options: Pick<FabricSemanticModelRuntimeOptions, 'baseUrl' | 'endpoints'>
): string {
  if (options.baseUrl !== undefined) {
    return options.baseUrl;
  }
  if (options.endpoints !== undefined) {
    return derivePowerBiBaseUrl(options.endpoints);
  }
  return DEFAULT_POWER_BI_BASE_URL;
}

/**
 * Build the dataset path, omitting `/groups/` for My Workspace (`'me'`).
 */
function datasetPath(target: FabricSemanticModelTarget): string {
  return target.workspaceId === 'me'
    ? `/datasets/${target.itemId}`
    : `/groups/${target.workspaceId}/datasets/${target.itemId}`;
}

/** Build a failed envelope so callers get one uniform shape on every path. */
function toErrorResponse(
  category: QueryErrorCategory,
  message: string,
  requestId: string,
  extra?: { code?: string; details?: string; recoveryHint?: string }
): FabricSemanticModelTabularResponse {
  return {
    status: 'Failed',
    output: {
      tables: [],
      requestId,
      responseError: {
        message,
        category,
        ...(extra?.code !== undefined ? { code: extra.code } : {}),
        ...(extra?.details ? { details: extra.details } : {}),
        ...(extra?.recoveryHint ? { recoveryHint: extra.recoveryHint } : {}),
      },
    },
    errors: [],
  };
}

/**
 * Extract a human-readable message from a Power BI error body.
 *
 * Power BI returns `{ error: { code, message } }` for most failures, but
 * gateway and auth layers in front of it can return plain text, so the raw
 * body is used as the fallback.
 */
function parseErrorBody(
  body: string,
  status: number
): { message: string; code?: string; recoveryHint?: string } {
  const trimmed = body.trim();
  const recoveryHint =
    status === 401 || status === 403
      ? trimmed.length === 0
        ? // Power BI describes a permissions failure; it does not answer with
          // nothing. An empty body means the request was rejected before the
          // service evaluated access to the model, so pointing the developer
          // at workspace permissions sends them auditing something that was
          // never the cause.
          'The request was rejected before Power BI evaluated model access, so check the token first: confirm the caller sends one and that it carries the https://analysis.windows.net/powerbi/api audience. Only then check workspace and semantic model permissions.'
        : 'Sign in again, and confirm you have at least Viewer access to the workspace/semantic model (Builder access if you also need to query it).'
      : undefined;

  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string };
    };
    const err = parsed.error;
    if (err?.message) {
      return {
        message: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
        ...(recoveryHint !== undefined ? { recoveryHint } : {}),
      };
    }
  } catch {
    // Not JSON, so fall through to the raw body.
  }

  return {
    message:
      trimmed.length > 0
        ? trimmed
        : `Power BI returned HTTP ${status} with an empty body.`,
    code: String(status),
    ...(recoveryHint !== undefined ? { recoveryHint } : {}),
  };
}

/**
 * Structured diagnostic fields worth surfacing from a failed connection.
 *
 * These are the fields Node's undici attaches to the `cause` of a network
 * `TypeError`, and they are the difference between "fetch failed" and
 * "ENOTFOUND for api.powerbi.com". The latter is actionable, the former is
 * not.
 */
const STRUCTURED_FIELDS = [
  'code',
  'syscall',
  'hostname',
  'address',
  'port',
] as const;

/**
 * Convert a thrown `fetch` failure into a categorised network error envelope.
 *
 * Node's `fetch` (undici) reports network failures as a
 * `TypeError('fetch failed')` with the actionable diagnostic on `err.cause`.
 * Browser `fetch` throws `TypeError('Failed to fetch')` with no `cause` at
 * all. This peeks at the immediate cause when present and surfaces its message
 * plus structured fields, otherwise it round-trips the outer message.
 *
 * Refs:
 * - https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch#exceptions
 * - https://nodejs.org/api/errors.html#errorcause
 * - https://undici.nodejs.org/#/docs/api/Errors
 *
 * @param err - The value thrown by `fetch`.
 * @param requestId - Correlation id to attach to the envelope.
 * @returns A failed envelope categorised `'network'`.
 */
export function toNetworkErrorResponse(
  err: unknown,
  requestId: string
): FabricSemanticModelTabularResponse {
  const baseMessage = err instanceof Error ? err.message : String(err);
  const cause =
    err && typeof err === 'object'
      ? (err as { cause?: unknown }).cause
      : undefined;

  let causeMessage = '';
  const detailParts: string[] = [];
  if (cause && typeof cause === 'object') {
    const obj = cause as Record<string, unknown>;
    if (typeof obj.message === 'string') causeMessage = obj.message;
    for (const field of STRUCTURED_FIELDS) {
      const value = obj[field];
      if (value !== undefined && value !== null && value !== '') {
        detailParts.push(`${field}=${String(value)}`);
      }
    }
  }

  // Avoid "fetch failed: fetch failed" when the cause's message duplicates the
  // outer error's.
  const message =
    causeMessage && causeMessage !== baseMessage
      ? `${baseMessage}: ${causeMessage}`
      : baseMessage;

  return toErrorResponse('network', message, requestId, {
    ...(detailParts.length > 0 ? { details: detailParts.join(', ') } : {}),
  });
}

/** Generate a correlation id, falling back when `crypto` is unavailable. */
function newRequestId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Turn a configured token provider into an `Authorization` header value.
 *
 * A provider that throws, or yields nothing, produces no header rather than a
 * failed request: the call then goes out with the connectors layer's own token
 * and fails at Power BI with a 401 or 403 that names the real problem, which is
 * more useful to a developer than an error raised here about token acquisition.
 *
 * A value that already carries a scheme is passed through, so a provider
 * returning either `'abc'` or `'Bearer abc'` behaves the same way.
 */
async function resolveAuthorization(
  getToken: FabricSemanticModelRuntimeOptions['getToken']
): Promise<string | undefined> {
  if (!getToken) return undefined;

  let token: string | undefined;
  try {
    token = await getToken();
  } catch {
    return undefined;
  }

  if (!token) return undefined;
  return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
}

/**
 * Issue a request and read its body, converting every failure mode into a
 * failed envelope.
 *
 * The client-generated `requestid` is sent up front *and* used as the fallback
 * correlation id, so an error always carries an id a developer can quote, even
 * when the request never reached a server that could assign one. When the
 * service does answer, its id wins, because that is the id its own telemetry
 * recorded.
 */
async function requestWithEnvelope<T>(
  http: InvokeHttpClient,
  url: string,
  body: unknown,
  accept: string,
  extraHeaders: Record<string, string>,
  readBody: (response: Response) => Promise<T>,
  onError: (
    body: string,
    status: number,
    requestId: string
  ) => FabricSemanticModelTabularResponse,
  onSuccess: (data: T, requestId: string) => FabricSemanticModelTabularResponse
): Promise<FabricSemanticModelTabularResponse> {
  const clientRequestId = newRequestId();

  let response: Response;
  try {
    response = await http.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: accept,
        ...extraHeaders,
        // Last so a caller cannot displace the id this function correlates on.
        requestid: clientRequestId,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return toNetworkErrorResponse(err, clientRequestId);
  }

  // Power BI echoes a server-assigned correlation id. It is only readable from
  // the response headers, which is why this path decodes the response here
  // rather than returning raw bytes for the `decodeBinary` hook. That hook
  // receives only the buffer and so could never attach the id.
  const requestId = response.headers.get('requestid') ?? clientRequestId;

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return onError(text, response.status, requestId);
  }

  let data: T;
  try {
    data = await readBody(response);
  } catch (err) {
    return toErrorResponse(
      'unknown',
      `Failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
      requestId
    );
  }

  try {
    return onSuccess(data, requestId);
  } catch (err) {
    return toErrorResponse(
      'unknown',
      `Failed to parse response: ${err instanceof Error ? err.message : String(err)}`,
      requestId
    );
  }
}

/**
 * Execute a DAX query directly against the public Power BI endpoint.
 *
 * Returns the same {@link FabricSemanticModelTabularResponse} envelope the
 * standalone (User Data Function) path produces, so both paths converge before
 * they reach `toQueryResult` and callers cannot tell them apart.
 *
 * A non-2xx response becomes a failed envelope rather than a thrown error, so a
 * Power BI failure (an expired token, a missing Build permission, a throttle)
 * surfaces verbatim to the developer instead of being masked by a silent
 * fall-back to a transport that would fail the same way.
 *
 * @param http - Pre-authenticated HTTP client from the connectors layer.
 * @param target - The semantic model to query.
 * @param query - The DAX query text.
 * @param options - Runtime options (base URL, token, query options).
 * @returns The decoded tabular response envelope. Never throws.
 */
export async function executeDaxDirect(
  http: InvokeHttpClient,
  target: FabricSemanticModelTarget,
  query: string,
  options: FabricSemanticModelRuntimeOptions = {}
): Promise<FabricSemanticModelTabularResponse> {
  const url = `${resolveBaseUrl(options)}${datasetPath(target)}/executeDaxQueries`;

  const body: Record<string, unknown> = { query };
  if (options.culture !== undefined) body.culture = options.culture;
  if (options.schemaOnly !== undefined) body.schemaOnly = options.schemaOnly;
  if (options.queryTimeout !== undefined) {
    body.queryTimeout = options.queryTimeout;
  }
  if (options.resultSetRowCountLimit !== undefined) {
    body.resultSetRowCountLimit = options.resultSetRowCountLimit;
  }

  const headers: Record<string, string> = {
    activityid: options.sessionId ?? '',
  };
  const authorization = await resolveAuthorization(options.getToken);
  if (authorization) {
    headers.Authorization = authorization;
  }

  return requestWithEnvelope(
    http,
    url,
    body,
    'application/vnd.apache.arrow.stream, application/json',
    headers,
    (response) => response.arrayBuffer(),
    (text, status, requestId) => {
      const { message, code, recoveryHint } = parseErrorBody(text, status);
      return toErrorResponse('api', message, requestId, {
        ...(code !== undefined ? { code } : {}),
        ...(text ? { details: text } : {}),
        ...(recoveryHint !== undefined ? { recoveryHint } : {}),
      });
    },
    (buffer, requestId) => parseArrowStream(buffer, requestId)
  );
}
