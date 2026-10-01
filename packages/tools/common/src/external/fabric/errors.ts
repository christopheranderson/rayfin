import { HttpError, parseRetryAfterHeader } from '../../utils/retry/index.js';

const MAX_ERROR_DETAIL_LENGTH = 512;
/**
 * Matches the parameter portion of a URL, capturing origin and path.
 *
 * Fabric puts identity in URL parameters (`?loginHint=<upn>`) but the origin
 * and path are usually the actionable part of a service message — an
 * enrollment or docs link the Builder is meant to follow. Redacting the whole
 * URL would remove the recovery step along with the identifier.
 */
const URL_PARAMS_PATTERN =
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>?#]*)[?#][^\s"'<>]*/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** Structured error returned by the Microsoft Fabric REST API. */
export class FabricError extends HttpError {
  constructor(
    message: string,
    statusCode: number,
    public readonly errorCode?: string,
    retryAfterMs?: number,
    options?: ErrorOptions
  ) {
    super(message, statusCode, retryAfterMs, options);
    this.name = 'FabricError';
  }
}

/**
 * Extract the service-side activity identifier from a Fabric response.
 * Prefers `x-ms-root-activity-id`, then falls back to `RequestId`. Surfacing
 * it in error messages lets a user correlate a failure with service-side
 * logs.
 */
export function getRootActivityId(response: Response): string | undefined {
  const rootActivityId = response.headers.get('x-ms-root-activity-id')?.trim();
  if (rootActivityId) {
    return rootActivityId;
  }

  const requestId =
    response.headers.get('RequestId')?.trim() ??
    response.headers.get('requestid')?.trim();

  return requestId || undefined;
}

/**
 * Build a structured, human-readable error message from a failed Fabric
 * response: the HTTP status, optional details, and the root activity id when
 * the service provided one.
 */
export function buildFabricErrorMessage(
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

/**
 * Extract a human-readable detail string from a parsed JSON error body.
 *
 * Fabric/Azure errors commonly nest the useful fields under an `error` object
 * (`{ error: { code, message } }`). Pull `message` (tagged with `code` when
 * both are present) out of that shape so the rendered detail stays actionable
 * instead of collapsing to `[object Object]`. A top-level `message`, a string
 * `error`, a top-level `errorCode`, a top-level `code`, or the first string
 * `errors[].detail` are also recognized. Unrecognized response shapes yield
 * `undefined`; raw JSON is never rendered because arbitrary service fields
 * may contain credentials or identity data.
 */
function extractErrorDetail(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const body = parsed as Record<string, unknown>;

  if (typeof body.message === 'string' && body.message) {
    return body.message;
  }

  if (typeof body.error === 'string' && body.error) {
    return body.error;
  }

  if (typeof body.error === 'object' && body.error !== null) {
    const nested = describeErrorObject(body.error as Record<string, unknown>);
    if (nested) {
      return nested;
    }
  }

  if (typeof body.code === 'string' && body.code) {
    return body.code;
  }

  if (typeof body.errorCode === 'string' && body.errorCode) {
    return body.errorCode;
  }

  if (Array.isArray(body.errors)) {
    for (const entry of body.errors) {
      if (typeof entry !== 'object' || entry === null) continue;
      const detail = asNonEmptyString(
        (entry as Record<string, unknown>).detail
      );
      if (detail) return detail;
    }
  }

  return undefined;
}

interface FabricErrorMetadata {
  errorCode?: string;
}

/** Extract machine-readable Fabric error metadata without matching messages. */
function extractErrorMetadata(parsed: unknown): FabricErrorMetadata {
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }

  const body = parsed as Record<string, unknown>;
  const nested =
    typeof body.error === 'object' && body.error !== null
      ? (body.error as Record<string, unknown>)
      : undefined;

  return {
    errorCode:
      asNonEmptyString(body.errorCode) ??
      asNonEmptyString(nested?.code) ??
      asNonEmptyString(body.code),
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Bound and redact service-provided text before it reaches output or telemetry.
 *
 * Identity is stripped outright; URLs keep their origin and path so the message
 * can still point somewhere useful.
 */
function sanitizeErrorDetail(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .replace(URL_PARAMS_PATTERN, '$1?[redacted]')
    .replace(EMAIL_PATTERN, '[redacted identity]')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, MAX_ERROR_DETAIL_LENGTH);
}

/** Render an `{ code, message }` error object as `message (code)`. */
function describeErrorObject(
  error: Record<string, unknown>
): string | undefined {
  const message = typeof error.message === 'string' ? error.message : undefined;
  const code = typeof error.code === 'string' ? error.code : undefined;

  if (message && code) {
    return `${message} (${code})`;
  }

  return message ?? code;
}

/**
 * Read a failed response body and throw a structured {@link FabricError}.
 *
 * Surfaces the most actionable detail from a JSON error body — including the
 * nested `{ error: { code, message } }` shape Fabric uses. Non-JSON responses
 * fall back to their raw text; unrecognized JSON fields are omitted so
 * credentials and identity-bearing values cannot be reflected into output.
 * All rendered detail text is bounded and redacted. Attaches the status code
 * and any `Retry-After` delay so the shared retry primitives can inspect them
 * without re-parsing the message.
 *
 * @throws Always — returns `Promise<never>`.
 */
export async function throwFabricError(
  response: Response,
  context: string
): Promise<never> {
  const text = await response.text();

  let details: string | undefined;
  let metadata: FabricErrorMetadata = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    metadata = extractErrorMetadata(parsed);
    details = extractErrorDetail(parsed);
  } catch {
    details = text;
  }

  throw new FabricError(
    buildFabricErrorMessage(response, context, sanitizeErrorDetail(details)),
    response.status,
    metadata.errorCode,
    parseRetryAfterHeader(response)
  );
}
