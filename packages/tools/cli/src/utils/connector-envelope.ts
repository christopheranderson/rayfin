/**
 * Reading a workload invocation envelope.
 *
 * Dependency-free on purpose: this shape is what the deployed BaaS route puts
 * on the wire, and staying standalone keeps it testable when the connector
 * packages are not built.
 */

/** A failed workload envelope, as far as anything here cares. */
interface WorkloadEnvelope {
  status?: unknown;
  errors?: unknown;
  invocationId?: unknown;
}

/**
 * `errorCode`/`subErrorCode`/`message`, as the workload writes them.
 *
 * `code` is the same field under the name `connector-kusto` uses.
 */
interface WorkloadErrorEntry {
  errorCode?: unknown;
  subErrorCode?: unknown;
  code?: unknown;
  message?: unknown;
}

/** `WorkloadException/Unauthorized: the message`, from one error entry. */
function describeEntry(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.trim() || undefined;
  if (!entry || typeof entry !== 'object') return undefined;

  const {
    errorCode,
    subErrorCode,
    code: legacyCode,
    message,
  } = entry as WorkloadErrorEntry;
  // `errorCode` wins, so a workload envelope carrying both is unchanged.
  const code = [errorCode ?? legacyCode, subErrorCode]
    .filter((value): value is string => typeof value === 'string' && !!value)
    .join('/');
  const text =
    typeof message === 'string' && message.trim() ? message.trim() : undefined;

  return [code || undefined, text].filter(Boolean).join(': ') || undefined;
}

/**
 * Whether the envelope carries no invocation id — the **all-zero GUID**.
 *
 * The workload builds a fresh response for any non-success and never assigns an
 * id, so all zeros means it synthesized the failure rather than relaying one
 * from a function that reported its own id. It does **not** prove the function
 * never started, and does not separate a transient rejection from a permanent
 * one.
 *
 * Matched against that exact shape, so a bare `"0"` is not the sentinel.
 */
export function invocationIdNotPropagated(invocationId: unknown): boolean {
  return (
    typeof invocationId === 'string' &&
    /^(?:0{32}|00000000-0000-0000-0000-000000000000)$/.test(invocationId)
  );
}

/**
 * Message for an envelope that reports its own failure; undefined when the
 * payload does not look failed.
 *
 * A 2xx is not a verdict: the deployed transport can answer 200 while the
 * envelope says the invocation failed, so reading only the HTTP status reports
 * success for a call that did nothing.
 *
 * Failure is `status: 'Failed'` **or** a non-empty `errors` array, not both.
 */
export function failedEnvelopeMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;

  const { status, errors, invocationId } = payload as WorkloadEnvelope;
  const failedStatus =
    typeof status === 'string' && status.toLowerCase() === 'failed';
  const entries = Array.isArray(errors) ? errors : [];

  if (!failedStatus && entries.length === 0) return undefined;

  const detail = entries
    .map(describeEntry)
    .filter((value): value is string => Boolean(value))
    .join('; ');

  const synthesized = invocationIdNotPropagated(invocationId)
    ? ' No invocation id was propagated into this failure envelope.'
    : '';

  return `${detail || 'The workload reported a failed invocation.'}${synthesized}`;
}
