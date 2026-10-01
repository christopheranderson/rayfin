/**
 * fabricAppState — deep-linking client for Rayfin apps embedded in Fabric.
 *
 * An embedded app cannot touch the portal address bar, so it hands the host
 * an opaque JSON object and the host owns the URL. That indirection is what
 * lets the encoding change without a breaking SDK release.
 *
 * @example
 * ```ts
 * const appState = createFabricAppStateClient();
 *
 * // Restore before first render so defaults never flash.
 * restoreApplicationState(appState.getLaunchStateSync());
 *
 * // User-initiated: Back should undo it.
 * await appState.setState({ view: 'sales-by-region', filter: 'AT' });
 *
 * // App-initiated: do not grow history.
 * await appState.replaceState({ view: 'sales-by-region', filter: 'DE' });
 *
 * const unsubscribe = appState.onStateChange(restoreApplicationState);
 * ```
 */

import {
  sendBridgeRequest,
  subscribeBridgeEvents,
} from '@microsoft/fabric-embedded-host';
import { assertBrowser } from '@microsoft/rayfin-lib';

import { toAppStateError } from './errors';
import { readLaunchStateFromUrl, scrubLaunchParamFromUrl } from './launchState';
import {
  FABRIC_APP_STATE_CHANNEL,
  KIND_CHANGED,
  KIND_GET_CAPABILITIES,
  KIND_GET_LAUNCH_STATE,
  KIND_PUSH,
  KIND_REPLACE,
} from './protocol';
import type {
  FabricAppState,
  FabricAppStateCapabilities,
  FabricAppStateClient,
  FabricAppStateClientOptions,
  FabricAppStateListener,
} from './types';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ENCODED_BYTES,
  validateAppState,
} from './validation';

interface StateResult {
  state?: FabricAppState;
  revision?: number;
}

/** An unregistered channel may mean the host bridge has not mounted yet. */
const READINESS_RETRY_LIMIT = 2;
const READINESS_RETRY_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a {@link FabricAppStateClient} bound to the Fabric host.
 *
 * Safe to call once per application; create a single instance and share
 * it rather than constructing one per component.
 */
export function createFabricAppStateClient(
  options: FabricAppStateClientOptions = {}
): FabricAppStateClient {
  assertBrowser('createFabricAppStateClient');

  const {
    target = window.parent,
    targetOrigin,
    timeoutMs,
    maxEncodedBytes = DEFAULT_MAX_ENCODED_BYTES,
    maxDepth = DEFAULT_MAX_DEPTH,
    launchSearch,
    scrubLaunchParam = true,
  } = options;

  const launchState = readLaunchStateFromUrl(launchSearch);

  // Only rewrite the address bar when the state actually came from it, and
  // only when embedded — a standalone page has no host that seeded it, so
  // scrubbing there would mutate a URL the client does not own.
  if (launchSearch === undefined && scrubLaunchParam && target !== window) {
    scrubLaunchParamFromUrl();
  }

  const listeners = new Set<FabricAppStateListener>();
  let unsubscribeBridge: (() => void) | undefined;
  let capabilitiesPromise:
    | Promise<FabricAppStateCapabilities | undefined>
    | undefined;

  /** Whether the last capability probe failed for a retryable reason. */
  let capabilitiesTransientMiss = false;

  /** `postMessage` gives no ordering guarantee, so stale events are dropped. */
  let lastRevision = -1;

  /** Generation of {@link lastRevision}; a change clears the high-water mark. */
  let lastEpoch = 0;

  /** Writes are chained so rapid calls reach the host in call order. */
  let writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * The replace waiting to be sent, and the flush that will send it.
   *
   * The value lives in a slot rather than a bare variable so the flush
   * sends whatever was pending when it was queued. A push closes the slot,
   * which keeps a later replace from joining a flush scheduled ahead of it.
   */
  let replaceSlot: { state: FabricAppState } | undefined;
  let replaceFlush: Promise<void> | undefined;

  function request<TPayload, TResult>(
    kind: string,
    payload: TPayload
  ): Promise<TResult> {
    return sendBridgeRequest<TPayload, TResult>({
      target,
      channel: FABRIC_APP_STATE_CHANNEL,
      kind,
      payload,
      ...(targetOrigin !== undefined ? { targetOrigin } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  /**
   * Fold a response revision into the event watermark.
   *
   * Responses carry no epoch, so one that was already in flight when the host
   * reset its counter would raise the watermark of the *new* epoch and
   * silently discard every event after it. Skipping the merge when the epoch
   * moved keeps the two generations from mixing, at the cost of one missed
   * watermark update.
   */
  function mergeResponseRevision(
    result: StateResult | undefined,
    epochAtRequest: number
  ): void {
    if (lastEpoch !== epochAtRequest) return;

    if (typeof result?.revision === 'number') {
      lastRevision = Math.max(lastRevision, result.revision);
    }
  }

  /** Serialise a write behind any in-flight writes. */
  function enqueueWrite(kind: string, state: FabricAppState): Promise<void> {
    // A Promise-returning method must never throw synchronously.
    try {
      validateAppState(state, maxEncodedBytes, maxDepth);
    } catch (err) {
      return Promise.reject(toAppStateError(err));
    }

    // Close the open replace slot so a replace issued after this push
    // queues behind it instead of collapsing into an earlier flush.
    replaceSlot = undefined;
    replaceFlush = undefined;

    const epochAtRequest = { value: lastEpoch };

    const send = () => {
      // Captured at send rather than enqueue, so queuing behind a slow write
      // does not needlessly widen the window.
      epochAtRequest.value = lastEpoch;
      return request<{ state: FabricAppState }, StateResult>(kind, { state });
    };

    // Chain on both settlement paths so one failure does not poison the queue.
    const run = writeQueue.then(send, send);

    writeQueue = run.catch(() => undefined);

    return run.then(
      (result) => {
        mergeResponseRevision(result, epochAtRequest.value);
      },
      (err) => {
        throw toAppStateError(err);
      }
    );
  }

  function ensureSubscribed(): void {
    if (unsubscribeBridge) return;

    unsubscribeBridge = subscribeBridgeEvents<StateResult>({
      source: target,
      channel: FABRIC_APP_STATE_CHANNEL,
      kind: KIND_CHANGED,
      ...(targetOrigin !== undefined ? { origin: targetOrigin } : {}),
      onEvent: (payload, revision, epoch) => {
        // A reset counter would otherwise sit below the high-water mark forever.
        if (epoch !== lastEpoch) {
          lastEpoch = epoch;
          lastRevision = -1;
        }

        if (revision <= lastRevision) return;
        lastRevision = revision;

        // Undefined means the URL carries no state; the app restores defaults.
        const state = payload?.state;

        // Copy: a listener may unsubscribe while the set is being walked.
        for (const listener of [...listeners]) {
          try {
            listener(state);
          } catch (err) {
            console.error('[FabricAppState] onStateChange listener threw', err);
          }
        }
      },
    });
  }

  /** Fill in any limits the host did not report with the client defaults. */
  function toCapabilities(
    raw?: Partial<FabricAppStateCapabilities>
  ): FabricAppStateCapabilities {
    return {
      version: typeof raw?.version === 'number' ? raw.version : 1,
      maxEncodedBytes:
        typeof raw?.maxEncodedBytes === 'number'
          ? raw.maxEncodedBytes
          : maxEncodedBytes,
      maxDepth: typeof raw?.maxDepth === 'number' ? raw.maxDepth : maxDepth,
      canPush: raw?.canPush !== false,
    };
  }

  /** Ask the host for its limits, tolerating a bridge that is still mounting. */
  async function requestCapabilities(): Promise<
    FabricAppStateCapabilities | undefined
  > {
    capabilitiesTransientMiss = false;

    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await request<
          Record<string, never>,
          Partial<FabricAppStateCapabilities>
        >(KIND_GET_CAPABILITIES, {});

        return toCapabilities(
          typeof raw === 'object' && raw !== null ? raw : undefined
        );
      } catch (err) {
        const { code } = toAppStateError(err);

        // A host still mounting its listener either rejects the channel or
        // does not answer at all, so both are retryable.
        if (
          code === 'UNSUPPORTED_HOST_CAPABILITY' ||
          code === 'BRIDGE_TIMEOUT'
        ) {
          if (attempt < READINESS_RETRY_LIMIT) {
            await delay(READINESS_RETRY_DELAY_MS);
            continue;
          }

          // Silence is not proof the feature is absent, so allow a later
          // call to probe again rather than hiding the feature for good.
          capabilitiesTransientMiss = code === 'BRIDGE_TIMEOUT';
          return undefined;
        }

        // Not embedded at all: definitive, so re-probing cannot help.
        if (code === 'NO_HOST_WINDOW') {
          return undefined;
        }

        // Answered but does not know this kind: an older host that still
        // services push and replace, so report defaults rather than hiding a
        // feature that works.
        if (code === 'UNKNOWN_OPERATION') {
          return toCapabilities();
        }

        // Anything else is an operational failure. Reporting capabilities
        // here would advertise a feature that is currently broken.
        return undefined;
      }
    }
  }

  return {
    getLaunchStateSync(): FabricAppState | undefined {
      return launchState;
    },

    async getLaunchState(): Promise<FabricAppState | undefined> {
      // Seeded onto the iframe URL before load, so no round trip is needed.
      if (launchState) return launchState;

      // Fallback for hosts that do not seed the URL.
      try {
        const epochAtRequest = lastEpoch;
        const result = await request<Record<string, never>, StateResult>(
          KIND_GET_LAUNCH_STATE,
          {}
        );
        mergeResponseRevision(result, epochAtRequest);
        return result?.state;
      } catch (err) {
        const error = toAppStateError(err);

        // Starting up must survive a host that predates this feature, is not
        // there at all, or is too slow to answer: all three mean "no launch
        // state", so callers need no try/catch around startup.
        if (
          error.code === 'UNSUPPORTED_HOST_CAPABILITY' ||
          error.code === 'NO_HOST_WINDOW' ||
          error.code === 'BRIDGE_TIMEOUT'
        ) {
          return undefined;
        }

        throw error;
      }
    },

    isSupported(): Promise<FabricAppStateCapabilities | undefined> {
      capabilitiesPromise ??= requestCapabilities().then((capabilities) => {
        // Definitive answers stay cached; a timeout is re-probed on the
        // next call so a host that mounts late is not missed forever.
        if (capabilities === undefined && capabilitiesTransientMiss) {
          capabilitiesPromise = undefined;
        }
        return capabilities;
      });
      return capabilitiesPromise;
    },

    setState(state: FabricAppState): Promise<void> {
      return enqueueWrite(KIND_PUSH, state);
    },

    replaceState(state: FabricAppState): Promise<void> {
      // Replace is used for continuous input such as a slider drag.
      // Sending every intermediate value would queue them behind one
      // round trip each and leave the URL visibly lagging the UI, so
      // only the newest pending value is written.
      try {
        validateAppState(state, maxEncodedBytes, maxDepth);
      } catch (err) {
        return Promise.reject(toAppStateError(err));
      }

      // Coalesce into the slot that is still waiting to be sent. Once a
      // push has closed it, open a new one so this value lands after it.
      const open = replaceSlot;
      if (open !== undefined && replaceFlush !== undefined) {
        open.state = state;
        return replaceFlush;
      }

      const slot = { state };
      replaceSlot = slot;

      const flush = writeQueue.then(runFlush, runFlush);
      writeQueue = flush.catch(() => undefined);
      replaceFlush = flush;

      return flush;

      async function runFlush(): Promise<void> {
        // Close the slot before sending so later replaces open a new one.
        if (replaceSlot === slot) {
          replaceSlot = undefined;
          replaceFlush = undefined;
        }

        try {
          const epochAtRequest = lastEpoch;
          const result = await request<{ state: FabricAppState }, StateResult>(
            KIND_REPLACE,
            { state: slot.state }
          );
          mergeResponseRevision(result, epochAtRequest);
        } catch (err) {
          throw toAppStateError(err);
        }
      }
    },

    onStateChange(listener: FabricAppStateListener): () => void {
      listeners.add(listener);
      ensureSubscribed();

      return () => {
        listeners.delete(listener);
        // Release the window listener once nobody is observing.
        if (listeners.size === 0 && unsubscribeBridge) {
          unsubscribeBridge();
          unsubscribeBridge = undefined;
        }
      };
    },

    dispose(): void {
      listeners.clear();
      if (unsubscribeBridge) {
        unsubscribeBridge();
        unsubscribeBridge = undefined;
      }
    },
  };
}
