/**
 * Launch-state seeding: decoding the state the host places on the app's
 * own iframe URL.
 *
 * Everything in this module is the **URL contract between the host and
 * this client**, not part of the Builder-facing surface.  Apps read
 * launch state through the client, never by parsing the URL themselves —
 * that is what allows the host to change the encoding (query parameter,
 * path segment, short link) without a breaking SDK release.
 *
 * @internal
 */

import type { FabricAppState } from './types';

/**
 * Query parameter the host places on the app's iframe URL to seed
 * launch state.
 *
 * Launch state must be available before first render, which a `postMessage`
 * round trip cannot provide. Seeding lets the app read it synchronously from
 * its own location.
 *
 * @internal
 */
export const LAUNCH_STATE_PARAM = 'fabricAppState';

/**
 * Encoding prefix, so the wire format can be versioned.
 *
 * Counts against the host's encoded-size budget, so the write-path
 * validator subtracts it before converting that budget to a raw-JSON one.
 *
 * @internal
 */
export const LAUNCH_STATE_PREFIX = 'v1.';

/**
 * Decode one base64url-encoded launch-state value.
 *
 * Returns `undefined` for anything unusable rather than throwing.
 * Tolerance is a requirement, not leniency: links shared while the
 * feature was enabled keep the parameter after it is disabled, and such
 * a link must still open the app in its default state.
 */
function decodeLaunchState(raw: string): FabricAppState | undefined {
  if (!raw.startsWith(LAUNCH_STATE_PREFIX)) return undefined;

  const encoded = raw.slice(LAUNCH_STATE_PREFIX.length);
  if (!encoded) return undefined;

  try {
    // base64url -> base64, restoring the padding atob() requires.
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      '='
    );

    // Reached through globalThis so the reference resolves in any
    // module system, and so lint does not treat it as an undeclared
    // browser global. Guarded because a non-browser host may lack it.
    const decodeBase64 = globalThis.atob;
    if (typeof decodeBase64 !== 'function') return undefined;

    const binary = decodeBase64(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);

    const parsed: unknown = JSON.parse(json);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }

    return parsed as FabricAppState;
  } catch {
    return undefined;
  }
}

/**
 * Read seeded launch state from the current document's URL.
 *
 * Synchronous and safe to call before first render.
 *
 * @param search - Query string to parse. Defaults to the live location,
 *                 and is injectable for tests.
 * @returns The decoded state, or `undefined` when absent or unusable.
 *
 * @internal
 */
export function readLaunchStateFromUrl(
  search?: string
): FabricAppState | undefined {
  const query =
    search ??
    (typeof window !== 'undefined' ? window.location.search : undefined);

  if (!query) return undefined;

  const raw = new URLSearchParams(query).get(LAUNCH_STATE_PARAM);
  if (!raw) return undefined;

  return decodeLaunchState(raw);
}

/**
 * Remove the seeded parameter from the app's own address bar.
 *
 * Leaving it would resend the state to the app's server on reload and expose
 * it in referrers to subresources. Only this frame's history entry is
 * rewritten; the portal URL, which the host owns, is untouched.
 *
 * @internal
 */
export function scrubLaunchParamFromUrl(): void {
  try {
    if (typeof window === 'undefined') return;

    const url = new URL(window.location.href);
    if (!url.searchParams.has(LAUNCH_STATE_PARAM)) return;

    url.searchParams.delete(LAUNCH_STATE_PARAM);
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`
    );
  } catch {
    // Hardening only; never let this break startup.
  }
}
