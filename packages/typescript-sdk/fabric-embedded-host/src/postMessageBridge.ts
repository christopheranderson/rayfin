import { SdkError, assertBrowser } from '@microsoft/rayfin-lib';

import type { MessageEnvelope } from './MessageProtocol';
import { isEventEnvelope } from './MessageProtocol';

/**
 * Default response timeout in milliseconds (30 seconds).
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Options for {@link sendBridgeRequest}.
 */
export interface BridgeRequestOptions<TPayload> {
  /** Target window to post the message to (typically `window.parent`). */
  target: Window;

  /** Channel identifier routed by the host's plugin registry. */
  channel: string;

  /** Message kind discriminator (e.g. `"auth.requestHandoff"`). */
  kind: string;

  /** Arbitrary payload attached to the message envelope. */
  payload: TPayload;

  /**
   * `targetOrigin` passed to `postMessage`.
   *
   * When set to a specific origin (e.g. `"https://app.fabric.microsoft.com"`),
   * the browser restricts delivery to that origin **and** the response handler
   * validates `event.origin` on incoming messages.
   *
   * Defaults to `"*"` — acceptable only when the payload contains no secrets
   * and the iframe cannot determine `window.parent.origin` at runtime.
   */
  targetOrigin?: string;

  /** Response timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

/**
 * Error thrown when a bridge request fails or times out.
 */
export class BridgeError extends SdkError {
  public override name = 'BridgeError';

  constructor(message: string, code?: string) {
    super(message, code);
    Object.setPrototypeOf(this, BridgeError.prototype);
  }
}

/**
 * Send a request through the postMessage bridge and wait for a
 * correlated response.
 *
 * The function:
 * 1. Generates a unique `requestId` (UUID v4).
 * 2. Posts a {@link MessageEnvelope}-shaped message to `target`.
 * 3. Listens for a response whose `requestId` matches and
 *    `kind === "response"`.
 * 4. Resolves with the `result` on success or rejects with a
 *    {@link BridgeError} on error/timeout.
 *
 * @typeParam TPayload - Shape of the request payload.
 * @typeParam TResult - Shape of the successful response result.
 */
export function sendBridgeRequest<TPayload, TResult>(
  options: BridgeRequestOptions<TPayload>
): Promise<TResult> {
  assertBrowser('sendBridgeRequest');
  const {
    target,
    channel,
    kind,
    payload,
    targetOrigin = '*',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (!target || target === window) {
    return Promise.reject(
      new BridgeError(
        'No host window — embedded mode requires an iframe host.',
        'NO_HOST_WINDOW'
      )
    );
  }

  const requestId = crypto.randomUUID();

  const request: MessageEnvelope & { payload: TPayload } = {
    channel,
    version: 1,
    kind,
    requestId,
    payload,
  };

  return new Promise<TResult>((resolve, reject) => {
    // eslint-disable-next-line prefer-const -- timeoutId must be declared before cleanup references it
    let timeoutId: ReturnType<typeof setTimeout>;

    function cleanup() {
      window.removeEventListener('message', handleResponse);
      clearTimeout(timeoutId);
    }

    function handleResponse(event: MessageEvent) {
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.requestId !== requestId) return;
      if (event.data.kind !== 'response') return;

      console.debug(
        `[PostMessageBridge] Response received from origin="${event.origin}", channel="${event.data.channel ?? '?'}"`
      );

      // Validate that the response came from the window we sent the
      // request to (window.parent).  This prevents other iframes or
      // windows from spoofing correlated responses.
      if (event.source !== target) {
        console.warn(
          '[PostMessageBridge] Ignoring response: event.source does not match target window'
        );
        return;
      }

      // When a specific targetOrigin was provided, validate the response
      // origin to ensure we only accept messages from the expected host.
      if (targetOrigin !== '*' && event.origin !== targetOrigin) {
        console.warn(
          `[PostMessageBridge] Ignoring response from origin="${event.origin}" (expected "${targetOrigin}")`
        );
        return;
      }

      if (event.data.version !== undefined && event.data.version !== 1) {
        console.warn(
          `[PostMessageBridge] Unexpected protocol version: ${event.data.version}`
        );
      }

      cleanup();

      if (event.data.success === true) {
        resolve(event.data.result as TResult);
      } else {
        const error = event.data.error ?? {
          code: 'UNKNOWN_ERROR',
          message: 'Unknown error from host.',
        };
        reject(new BridgeError(error.message, error.code));
      }
    }

    window.addEventListener('message', handleResponse);

    timeoutId = setTimeout(() => {
      cleanup();
      reject(
        new BridgeError(
          `Bridge request timed out after ${timeoutMs}ms. The host did not respond.`,
          'BRIDGE_TIMEOUT'
        )
      );
    }, timeoutMs);

    target.postMessage(request, targetOrigin);
  });
}

/**
 * Options for {@link subscribeBridgeEvents}.
 */
export interface BridgeEventSubscriptionOptions<TPayload> {
  /** Window expected to publish the events (typically `window.parent`). */
  source: Window;

  /** Channel identifier to listen on (e.g. `"fabric-app-state"`). */
  channel: string;

  /** Event kind to listen for (e.g. `"appState.changed"`). */
  kind: string;

  /**
   * Origin the events must originate from.
   *
   * When set to a specific origin, any event arriving from a different
   * origin is dropped.  Defaults to `"*"`, which disables the origin
   * check and should only be used when the payload is non-sensitive and
   * the iframe cannot determine `window.parent.origin` at runtime.
   */
  origin?: string;

  /** Invoked once per accepted event, in delivery order. */
  onEvent: (payload: TPayload, revision: number, epoch: number) => void;
}

/**
 * Subscribe to unsolicited host-to-iframe events on a channel.
 *
 * This is the push counterpart to {@link sendBridgeRequest}.  The bridge
 * is otherwise strictly request/response, so an app has no way to learn
 * about state the host changed on its own — for example when the user
 * presses the browser Back button.
 *
 * Every inbound message is validated before the listener is invoked:
 * source window identity, origin (when configured), envelope shape,
 * protocol version, channel, and kind.  Anything that fails is silently
 * dropped, because a hostile page may post arbitrary messages.
 *
 * Ordering is *not* guaranteed by `postMessage`, so callers should use
 * the `revision` argument to discard stale events.
 *
 * @returns An unsubscribe function.  Always call it when the component
 *          or client is disposed, otherwise the listener leaks.
 */
export function subscribeBridgeEvents<TPayload>(
  options: BridgeEventSubscriptionOptions<TPayload>
): () => void {
  assertBrowser('subscribeBridgeEvents');
  const { source, channel, kind, origin = '*', onEvent } = options;

  function handleEvent(event: MessageEvent) {
    // Reject anything not sent by the exact window we expect.  An origin
    // check alone is insufficient: a different iframe on the same origin
    // could otherwise forge events.
    if (event.source !== source) return;

    if (origin !== '*' && event.origin !== origin) {
      console.warn(
        `[PostMessageBridge] Ignoring event from origin="${event.origin}" (expected "${origin}")`
      );
      return;
    }

    if (!isEventEnvelope(event.data)) return;
    if (event.data.channel !== channel) return;
    if (event.data.kind !== kind) return;

    if (event.data.version !== 1) {
      console.warn(
        `[PostMessageBridge] Unexpected event protocol version: ${event.data.version}`
      );
      return;
    }

    const { payload, revision, epoch } = event.data as typeof event.data & {
      payload: TPayload;
    };

    try {
      onEvent(payload, revision, epoch);
    } catch (err) {
      // A throwing listener must not tear down the bridge for everyone.
      console.error(
        `[PostMessageBridge] Event listener for "${kind}" threw`,
        err
      );
    }
  }

  window.addEventListener('message', handleEvent);

  return () => {
    window.removeEventListener('message', handleEvent);
  };
}
