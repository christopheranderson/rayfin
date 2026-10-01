/**
 * MessageProtocol — type definitions for the postMessage bridge
 * between a hosted Rayfin SPA (inside an iframe) and the Fabric
 * extension host (EmbeddedAppHost).
 *
 * All messages flowing through the bridge conform to the
 * {@link MessageEnvelope} shape, which carries a `channel` for
 * plugin routing, a monotonic `version`, a `kind` discriminator,
 * and a `requestId` for response correlation.
 */

// ── Core envelope ────────────────────────────────────────────

/**
 * Fields common to every message on the bridge, whether it is a
 * request, a response, or an unsolicited event.
 *
 * The discriminator between the two families is which identifier is
 * present: {@link MessageEnvelope} carries `requestId`, and
 * {@link EventEnvelope} carries `revision`.
 */
export interface EnvelopeBase {
  /** Plugin channel identifier (e.g. `"fabric-auth"`). */
  channel: string;
  /** Protocol version — currently `1`. */
  version: number;
  /** Discriminator for the message type (e.g. `"auth.requestHandoff"`, `"response"`). */
  kind: string;
}

/**
 * Base envelope for every message exchanged over the postMessage bridge.
 *
 * The iframe sends requests and the host replies with responses that
 * echo the same `channel`, `version`, and `requestId`.
 */
export interface MessageEnvelope extends EnvelopeBase {
  /** Unique identifier for request/response correlation. */
  requestId: string;
}

// ── Generic response wrappers ────────────────────────────────

/**
 * Error detail included in an {@link ErrorResponse}.
 */
export interface ResponseError {
  /** Machine-readable error code (e.g. `"UNKNOWN_CHANNEL"`, `"PLUGIN_ERROR"`). */
  code: string;
  /** Human-readable error description. */
  message: string;
}

/**
 * Success response sent from the host back to the iframe.
 */
export interface SuccessResponse<T = unknown> extends MessageEnvelope {
  kind: 'response';
  success: true;
  /** Plugin-specific result payload. */
  result: T;
}

/**
 * Error response sent from the host back to the iframe.
 */
export interface ErrorResponse extends MessageEnvelope {
  kind: 'response';
  success: false;
  /** Structured error detail. */
  error: ResponseError;
}

/**
 * Union of all possible response shapes sent from the host.
 */
export type BridgeResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

// ── Event envelope ───────────────────────────────────────────

/**
 * Envelope for **unsolicited** host-to-iframe events.
 *
 * Requests and responses are correlated by `requestId`; events are not
 * correlated to anything because the iframe never asked for them.  They
 * are published by the host when external input changes state that the
 * app needs to observe — for example the user pressing the browser Back
 * button, or opening a deep link in a new tab.
 *
 * Events carry no `requestId`, which is what keeps them out of
 * `sendBridgeRequest`'s reply path: that handler drops any message whose
 * `kind` is not `"response"`, and separately requires `requestId` to
 * match the pending request.  The `kind` check is the load-bearing one;
 * the missing `requestId` is a second, incidental barrier.
 */
export interface EventEnvelope extends EnvelopeBase {
  /**
   * Monotonically increasing sequence number scoped to the channel.
   *
   * `postMessage` delivery order is not guaranteed to match the order in
   * which the host committed the changes, so subscribers must discard any
   * event whose `revision` is not greater than the last one applied.
   *
   * This doubles as the event's identity: it is unique and ordered within
   * an epoch, so no separate identifier is required.
   */
  revision: number;

  /**
   * Generation counter for {@link EventEnvelope.revision}.
   *
   * A host that restarts its revision counter must bump `epoch` in the same
   * event; otherwise a subscriber's high-water mark discards every event that
   * follows. Required, because a host that omitted it would look like a
   * permanent epoch `0` and that suppression would be silent.
   */
  epoch: number;

  /**
   * Optional opaque identifier for one event instance.
   *
   * Not used for correlation or de-duplication — `revision` covers both.
   * It exists so a host can stamp events for log correlation, and is
   * deliberately optional so that a host which does not need it is not
   * forced to generate one.
   */
  eventId?: string;
}

/**
 * A host-to-iframe event together with its payload.
 */
export interface BridgeEvent<T = unknown> extends EventEnvelope {
  /** Event-specific payload. */
  payload: T;
}

// ── Envelope validation ──────────────────────────────────────

/**
 * Type guard that validates whether a value conforms to the
 * {@link MessageEnvelope} shape.
 */
export function isMessageEnvelope(data: unknown): data is MessageEnvelope {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.channel === 'string' &&
    typeof obj.version === 'number' &&
    typeof obj.kind === 'string' &&
    typeof obj.requestId === 'string'
  );
}

/**
 * Type guard that validates whether a value conforms to the
 * {@link EventEnvelope} shape.
 *
 * Messages arrive from another browsing context and must be treated as
 * untrusted input, so every field is checked explicitly rather than
 * assumed — TypeScript interfaces are erased at runtime and provide no
 * protection here.
 */
export function isEventEnvelope(data: unknown): data is EventEnvelope {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.channel === 'string' &&
    typeof obj.version === 'number' &&
    typeof obj.kind === 'string' &&
    typeof obj.revision === 'number' &&
    Number.isFinite(obj.revision) &&
    // Required: a missing epoch reads as a permanent generation 0, and a
    // non-finite one never compares equal to itself, so the subscriber would
    // reset its high-water mark on every event and lose replay protection.
    typeof obj.epoch === 'number' &&
    Number.isFinite(obj.epoch) &&
    // Optional: reject a present-but-wrongly-typed value, accept absence.
    (obj.eventId === undefined || typeof obj.eventId === 'string')
  );
}
