/**
 * Shared HTTP client utilities for the Rayfin CLI.
 *
 * Consolidates the common pattern of POSTing JSON with optional
 * Authorization headers used across dab-apply, storage-apply,
 * and apply-project-runtime-settings.
 */

import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { getRootActivityId } from '@microsoft/rayfin-tools-common/_internal/external/fabric';

import { recordFabricResponseActivity } from '../telemetry/enrichment.js';

import { HttpError, parseRetryAfterHeader } from './retry-utils.js';

export { getRootActivityId };

export interface PostJsonOptions {
  diagnostics?: Diagnostics;
  /** Target URL */
  url: string;
  /** Request body (will be JSON-stringified) */
  body: unknown;
  /** Optional Authorization header value */
  authorizationHeader?: string;
  /** Additional headers to merge into the request */
  extraHeaders?: Record<string, string>;
}

export function buildRemoteErrorMessage(
  response: Response,
  context: string,
  details?: string
): string {
  let message = `${context}: ${response.status}`;

  if (response.statusText) {
    message += ` ${response.statusText}`;
  }

  if (details) {
    message += `\n   Details: ${details}`;
  }

  const rootActivityId = getRootActivityId(response);
  if (rootActivityId) {
    message += `\n   RootActivityId: ${rootActivityId}`;
  }

  return message;
}

/** Fetch a Fabric or Power BI endpoint and record its response correlation ID. */
export async function fabricFetch(
  input: string | URL | Request,
  init?: RequestInit,
  diagnostics?: Diagnostics
): Promise<Response> {
  const startedAt = Date.now();
  const method =
    init?.method ?? (input instanceof Request ? input.method : 'GET');
  diagnostics?.debug({
    area: 'http',
    message: 'Request started',
    data: { method },
  });
  try {
    const response = await fetch(input, init);
    recordFabricResponseActivity(response);
    diagnostics?.debug({
      area: 'http',
      message: 'Response received',
      data: {
        method,
        status: response.status,
        durationMs: Date.now() - startedAt,
      },
    });
    return response;
  } catch (error) {
    diagnostics?.debug({
      area: 'http',
      message: 'Request failed',
      data: {
        method,
        errorType: error instanceof Error ? error.name : 'Unknown',
        durationMs: Date.now() - startedAt,
      },
    });
    throw error;
  }
}

/**
 * Send a POST request with a JSON body.
 * @param options - Request configuration
 * @returns The raw Response object for caller-specific error handling
 */
export async function postJson(options: PostJsonOptions): Promise<Response> {
  return postJsonWith(options, fetch);
}

/** POST JSON to a Fabric endpoint through the telemetry-aware transport. */
export async function postFabricJson(
  options: PostJsonOptions
): Promise<Response> {
  return postJsonWith(options, (input, init) =>
    fabricFetch(input, init, options.diagnostics)
  );
}

async function postJsonWith(
  options: PostJsonOptions,
  fetcher: typeof fetch
): Promise<Response> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (options.authorizationHeader) {
    headers['Authorization'] = options.authorizationHeader;
  }

  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders);
  }

  return fetcher(options.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body),
  });
}

/**
 * Assert that a fetch response is OK, throwing a structured error if not.
 *
 * On error the response body is read and, when possible, parsed as JSON to
 * extract the service's own message. Only a string is accepted: the control
 * plane returns its remediation under `message` at the root for some errors and
 * nested under `error` for others, and interpolating an object would render the
 * whole thing as `[object Object]` and lose the advice it carries.
 *
 * On success the already-read body text is returned so callers can consume it
 * without a second `response.text()` call.
 *
 * @param response - The fetch Response to check
 * @param context  - A human-readable prefix for the error message
 *                   (e.g. `'DAB server responded with error'`)
 * @param transformErrorDetails - Optional boundary-specific rewrite for the
 *                                extracted service message and error code
 * @returns The response body text when the response is OK
 * @throws `HttpError` with a structured message and status code when `!response.ok`
 */
export async function throwIfNotOk(
  response: Response,
  context: string,
  transformErrorDetails?: (details: string, code?: string) => string
): Promise<string> {
  const text = await response.text();

  if (!response.ok) {
    const { details, code } = extractErrorDetails(text);
    throw new HttpError(
      buildRemoteErrorMessage(
        response,
        context,
        transformErrorDetails ? transformErrorDetails(details, code) : details
      ),
      response.status,
      parseRetryAfterHeader(response)
    );
  }

  return text;
}

/** Pull the service's own message out of an error body, or fall back to it whole. */
function extractErrorDetails(text: string): {
  details: string;
  code?: string;
} {
  try {
    const json = JSON.parse(text);
    const candidates = [json?.message, json?.error?.message, json?.error];
    const detail = candidates.find((value) => typeof value === 'string');
    const codeCandidates = [json?.code, json?.error?.code, json?.errorCode];
    const code = codeCandidates.find((value) => typeof value === 'string');
    return { details: detail ?? text, code };
  } catch {
    return { details: text };
  }
}

/**
 * Re-throw an error, wrapping ECONNREFUSED with a user-friendly message
 * that distinguishes local vs remote endpoints.
 *
 * Always throws — use at the end of a `catch` block to replace the
 * common `if (ECONNREFUSED) { … } throw error;` pattern.
 *
 * @param error    - The caught error value
 * @param endpoint - The URL that was being contacted (used for the message
 *                   and to detect local vs remote)
 */
export function wrapConnectionError(error: unknown, endpoint: string): never {
  if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
    const isLocal =
      endpoint.includes('localhost') || endpoint.includes('127.0.0.1');
    const helpText = isLocal
      ? "\n💡 Make sure the Rayfin server is running (try 'rayfin dev')"
      : '\n💡 Check if the remote endpoint is accessible and healthy';
    throw new Error(
      `Cannot connect to Rayfin server at ${endpoint}${helpText}`
    );
  }

  throw error;
}
