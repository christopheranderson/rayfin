/**
 * Public types for the deep-link application state client.
 */

/**
 * A single JSON-compatible value permitted inside {@link FabricAppState}.
 *
 * `undefined`, functions, symbols, `NaN`, and `Infinity` are excluded
 * because they cannot survive a JSON round trip through the URL.
 */
export type FabricAppStateValue =
  | string
  | number
  | boolean
  | null
  | FabricAppStateValue[]
  | { [key: string]: FabricAppStateValue };

/**
 * Application state persisted into the shareable Fabric portal URL.
 *
 * **Never place secrets, access tokens, or personal data here.** The
 * value is visible in browser history, screenshots, copied links,
 * corporate proxy logs, and anywhere the link is pasted.  Use an opaque
 * identifier that maps to server-side data when the state is sensitive
 * or large.
 */
export interface FabricAppState {
  [key: string]: FabricAppStateValue;
}

/** Options accepted by `createFabricAppStateClient`. */
export interface FabricAppStateClientOptions {
  /** Host window. Defaults to `window.parent`. */
  target?: Window;

  /**
   * Expected origin of the Fabric host.
   *
   * Leave unset.  The embedding extension host does not share the portal
   * origin shown in the address bar and varies per environment, so a pinned
   * value makes the browser drop every message silently.  When omitted,
   * messages are posted with `"*"` and inbound events are not origin-checked.
   */
  targetOrigin?: string;

  /** Per-request timeout in milliseconds. Defaults to the bridge default. */
  timeoutMs?: number;

  /** Override for the default encoded-size ceiling. */
  maxEncodedBytes?: number;

  /** Override for the default nesting-depth ceiling. */
  maxDepth?: number;

  /**
   * Query string to read seeded launch state from.
   *
   * Defaults to the live `window.location.search`.  Injectable for
   * tests and for hosts that supply the value by another route.
   */
  launchSearch?: string;

  /**
   * Whether to remove the seeded parameter from the app's own URL once
   * it has been read. Defaults to `true`.
   *
   * Leaving it in place would resend the state to the app's own server
   * on every reload and expose it in referrers to subresources.
   */
  scrubLaunchParam?: boolean;
}

/**
 * Limits and features reported by the Fabric host.
 *
 * The host is authoritative. The client's own limits exist only to fail
 * fast before a round trip, so treat these values as the real contract.
 */
export interface FabricAppStateCapabilities {
  /** App-state protocol version implemented by the host. */
  version: number;

  /** Largest encoded state the host will accept, in bytes. */
  maxEncodedBytes: number;

  /** Deepest nesting the host will accept. */
  maxDepth: number;

  /**
   * Whether the host can create browser history entries.
   *
   * When `false`, {@link FabricAppStateClient.setState} still updates the
   * URL — so links stay shareable — but no history entry is created and
   * in-app Back and Forward will not work. Hide affordances that depend
   * on history when this is `false`.
   */
  canPush: boolean;
}

/**
 * Listener invoked when the host reports externally-changed state.
 *
 * Receives `undefined` when navigation reaches a URL that carries no
 * state, which means the app should restore its own defaults. Treat the
 * value as untrusted: anyone can edit a link before sharing it.
 */
export type FabricAppStateListener = (
  state: FabricAppState | undefined
) => void;

/**
 * Typed client for reading and writing deep-link state.
 */
export interface FabricAppStateClient {
  /**
   * Read the state the app was launched with.
   *
   * Returns `undefined` when the URL carries no state, which is the
   * normal case for a fresh navigation.
   *
   * Resolves **synchronously** from the seeded iframe URL when the host
   * supports it, so awaiting this does not delay first render.  Falls
   * back to a bridge round trip only on hosts that do not seed the URL.
   *
   * Use {@link FabricAppStateClient.getLaunchStateSync} when the state
   * is needed in a code path that cannot be asynchronous at all.
   */
  getLaunchState(): Promise<FabricAppState | undefined>;

  /**
   * Read seeded launch state without awaiting.
   *
   * Returns `undefined` when the host did not seed the URL, in which
   * case {@link FabricAppStateClient.getLaunchState} must be awaited.
   * Intended for the first render path, where launch state must be
   * available before paint.
   */
  getLaunchStateSync(): FabricAppState | undefined;

  /**
   * Resolve the host's capabilities, or `undefined` when the host does
   * not support deep-link state.
   *
   * Deep linking rolls out per tenant, so check this before showing a
   * share button rather than letting the user click one that cannot
   * work. The result is cached.
   *
   * @example
   * ```ts
   * const capabilities = await appState.isSupported();
   * if (capabilities?.canPush) enableBackForwardHints();
   * ```
   */
  isSupported(): Promise<FabricAppStateCapabilities | undefined>;

  /**
   * Commit state as a new browser history entry.
   *
   * Choose between this and {@link FabricAppStateClient.replaceState} by
   * **who caused the change**:
   *
   * - The *user* caused it — a click, a filter change, opening a record.
   *   Use `setState`, so Back returns them to where they were.
   * - The *app* caused it — restoring, reconciling, or normalising state
   *   the user did not ask for. Use `replaceState`, so Back is not
   *   cluttered with entries the user never navigated to.
   *
   * @example
   * ```ts
   * // The user picked a region: Back should undo it.
   * await appState.setState({ view: 'sales', region: 'AT' });
   * ```
   */
  setState(state: FabricAppState): Promise<void>;

  /**
   * Commit state by replacing the current history entry.
   *
   * Use for app-initiated changes and for high-frequency updates such as
   * a slider drag, where one history entry per update would make Back
   * unusable.  See {@link FabricAppStateClient.setState} for the rule.
   *
   * **Platform caveat:** the Fabric host downgrades a replace to a push
   * when the previous history entry belongs to a different extension, to
   * stop one extension overwriting another's history.  The first
   * `replaceState()` after the user arrives from elsewhere in Fabric may
   * therefore create an entry.  This is platform behaviour and cannot be
   * overridden.
   *
   * @example
   * ```ts
   * // Continuous updates while dragging: do not grow history.
   * await appState.replaceState({ view: 'sales', threshold: value });
   * ```
   */
  replaceState(state: FabricAppState): Promise<void>;

  /**
   * Observe state changes the app did not initiate: browser Back or
   * Forward, or a deep link opened in the current tab.
   *
   * Echoes of the app's own writes are suppressed by the host.
   *
   * @returns An unsubscribe function.
   */
  onStateChange(listener: FabricAppStateListener): () => void;

  /** Remove all listeners and release the underlying bridge subscription. */
  dispose(): void;
}
