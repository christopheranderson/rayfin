/** Reason phrase and optional recovery hint for one HTTP status code. */
interface HttpStatusInfo {
  reason: string;
  hint?: string;
}

/**
 * Friendly reason phrases and recovery hints for HTTP status codes
 * developers commonly hit while interacting with Rayfin services.
 */
export const HTTP_STATUS_INFO: Readonly<Record<number, HttpStatusInfo>> = {
  400: {
    reason: 'Bad Request',
    hint: 'Validate the request payload and retry.',
  },
  401: {
    reason: 'Unauthorized',
    hint: 'Sign in again and verify your identity has access to the target workspace/item.',
  },
  402: { reason: 'Payment Required' },
  403: {
    reason: 'Forbidden',
    hint: 'Your identity is authenticated but does not have required permissions for this operation.',
  },
  404: {
    reason: 'Not Found',
    hint: 'The target resource was not found. Verify IDs and environment targeting, then retry.',
  },
  405: { reason: 'Method Not Allowed' },
  406: { reason: 'Not Acceptable' },
  408: {
    reason: 'Request Timeout',
    hint: 'The request timed out. Retry in a moment.',
  },
  409: {
    reason: 'Conflict',
    hint: 'The operation conflicted with current resource state. Refresh state and retry.',
  },
  410: { reason: 'Gone' },
  412: { reason: 'Precondition Failed' },
  413: {
    reason: 'Payload Too Large',
    hint: 'The request payload is too large. Reduce payload size and retry.',
  },
  414: { reason: 'URI Too Long' },
  415: {
    reason: 'Unsupported Media Type',
    hint: 'Unsupported content type. Ensure the request uses a supported format and retry.',
  },
  422: {
    reason: 'Unprocessable Content',
    hint: 'The request was understood but rejected by validation. Check fields and values, then retry.',
  },
  423: { reason: 'Locked' },
  424: { reason: 'Failed Dependency' },
  425: { reason: 'Too Early' },
  426: { reason: 'Upgrade Required' },
  428: { reason: 'Precondition Required' },
  429: {
    reason: 'Too Many Requests',
    hint: 'Too many requests were sent. Wait briefly and retry.',
  },
  431: { reason: 'Request Header Fields Too Large' },
  500: {
    reason: 'Internal Server Error',
    hint: 'The remote service encountered an internal error. Retry shortly; if it persists, contact support with request IDs.',
  },
  501: { reason: 'Not Implemented' },
  502: {
    reason: 'Bad Gateway',
    hint: 'Bad gateway from an upstream service. Retry in a moment.',
  },
  503: {
    reason: 'Service Unavailable',
    hint: 'Service is temporarily unavailable. Retry after a short delay.',
  },
  504: {
    reason: 'Gateway Timeout',
    hint: 'Gateway timeout from the remote service. Retry in a moment.',
  },
  505: { reason: 'HTTP Version Not Supported' },
};

export function formatHttpStatus(status: number): string {
  const reason = HTTP_STATUS_INFO[status]?.reason;
  return reason ? `HTTP ${status} ${reason}` : `HTTP ${status}`;
}

export function getHttpErrorRecoveryHint(
  status: number,
  fallback: string
): string {
  return HTTP_STATUS_INFO[status]?.hint ?? fallback;
}
