import { assertBrowser } from '@microsoft/rayfin-lib';

/**
 * Embedded-mode detection utilities.
 *
 * An app is considered "embedded" when it runs inside a Fabric extension
 * iframe rather than as a standalone page.  Detection uses a priority
 * waterfall:
 *
 * 1. An explicit `fabricEmbedded` boolean option (highest priority).
 * 2. A `?fabricEmbedded=true` query parameter in the current URL —
 *    set by the Fabric Portal when it loads the SPA in an iframe.
 * 3. A `sessionStorage` flag persisted after step 2, so that
 *    client-side navigations that strip query params keep working.
 */

const EMBEDDED_QUERY_PARAM = 'fabricEmbedded';
const EMBEDDED_STORAGE_KEY = 'fabricEmbedded';

/**
 * Persists the embedded-mode flag to `sessionStorage` if the current
 * URL contains `?fabricEmbedded=true`.
 *
 * Safe to call multiple times and on any page load.  Returns `true`
 * when the URL flag was present (whether or not it was newly written).
 *
 * This is invoked eagerly at module load below so that the flag is
 * captured even when no consumer calls {@link isEmbeddedMode} on the
 * initial render — for example when an existing session resumes from
 * a refresh token and the embedded auth path is short-circuited.
 */
export function persistEmbeddedModeFromUrl(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    if (
      new URLSearchParams(window.location.search).get(EMBEDDED_QUERY_PARAM) ===
      'true'
    ) {
      try {
        sessionStorage.setItem(EMBEDDED_STORAGE_KEY, 'true');
      } catch (err) {
        // sessionStorage may be unavailable in sandboxed iframes
        console.warn(
          'Unable to persist embedded mode flag to sessionStorage',
          err
        );
      }
      return true;
    }
  } catch {
    // window.location may be unavailable in some non-browser hosts
  }
  return false;
}

// Eagerly capture the URL flag at module load so client-side
// navigations or refresh-token resumes that bypass isEmbeddedMode()
// still leave the flag persisted for later auth calls.
persistEmbeddedModeFromUrl();

/**
 * Options accepted by {@link isEmbeddedMode}.
 *
 * Both the Rayfin auth SDK (`FabricAuthOptions`) and the Fabric SDK
 * can satisfy this interface — only the `fabricEmbedded` flag matters.
 */
export interface EmbeddedModeOptions {
  /**
   * When `true`, force embedded mode regardless of the URL or
   * sessionStorage.  When `undefined` or `false`, fall through to
   * URL / sessionStorage detection.
   */
  fabricEmbedded?: boolean;
}

/**
 * Detects whether the app is running in embedded mode.
 *
 * Priority:
 * 1. `options.fabricEmbedded === true` — explicit opt-in.
 * 2. `?fabricEmbedded=true` in `window.location.search` — set by
 *    the Fabric Portal; persisted to sessionStorage on first hit.
 * 3. `sessionStorage` flag from a previous URL detection.
 *
 * @returns `true` when the app should use the embedded postMessage
 *          auth flow instead of the popup/redirect flow.
 */
export function isEmbeddedMode(options: EmbeddedModeOptions): boolean {
  assertBrowser('isEmbeddedMode');
  if (options.fabricEmbedded === true) {
    return true;
  }

  // Re-check the URL (and persist if present) in case the module was
  // loaded before navigation added the query param.
  if (persistEmbeddedModeFromUrl()) {
    return true;
  }

  try {
    if (sessionStorage.getItem(EMBEDDED_STORAGE_KEY) === 'true') {
      return true;
    }
  } catch {
    // sessionStorage unavailable
  }

  return false;
}

/**
 * Clears the persisted embedded-mode flag from sessionStorage.
 *
 * Useful in testing or when the app explicitly exits embedded mode.
 */
export function clearEmbeddedMode(): void {
  assertBrowser('clearEmbeddedMode');
  try {
    sessionStorage.removeItem(EMBEDDED_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable
  }
}
