import { assertBrowser } from '@microsoft/rayfin-lib';

/** @internal BroadcastChannel name for backward-compat cross-tab handoff messaging. */
export const FABRIC_AUTH_CHANNEL = 'rayfin_fabric_auth';

/**
 * Bridge for backward compatibility with legacy broker redirect flows.
 *
 * Legacy brokers redirect the popup to the SPA's callback URL with handoff
 * params instead of using postMessage. This function detects that scenario,
 * forwards the params to the opener tab, and closes the popup.
 *
 * Delivery: postMessage when `window.opener` exists, BroadcastChannel otherwise.
 *
 * Call early in your callback page. Returns `true` if bridge fired (skip
 * other callback handling), `false` if no handoff params detected.
 *
 * @deprecated Remove once legacy redirect flow is fully retired.
 * @returns Whether a bridge message was sent.
 */
export function bridgeFabricCallback(): boolean {
  assertBrowser('bridgeFabricCallback');
  // Query params first, then hash fragment. Only match verification_code/code
  // from query params when window.opener exists (popup context) to avoid
  // colliding with magic-link callbacks that use the same param names.
  const queryParams = new URLSearchParams(window.location.search);
  const hashRaw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hashParams = new URLSearchParams(hashRaw);

  // With opener: any code param could be a brokered handoff.
  // Without opener: only the explicit `handoff` param is unambiguous.
  const queryHandoffCode = window.opener
    ? queryParams.get('verification_code') ||
      queryParams.get('code') ||
      queryParams.get('handoff')
    : queryParams.get('handoff');

  const handoffCode =
    queryHandoffCode ||
    hashParams.get('handoff') ||
    hashParams.get('verification_code') ||
    hashParams.get('code') ||
    null;
  const state = queryParams.get('state') || hashParams.get('state') || null;

  if (!handoffCode || !state) {
    return false;
  }

  const payload = { type: 'brokeredAuth.handoff', state, handoffCode };

  if (window.opener) {
    // postMessage to same-origin opener.
    console.debug(
      '[FabricAuth] Bridge: forwarding handoff via postMessage to opener'
    );
    window.opener.postMessage(payload, window.location.origin);
  } else {
    // Opener severed — fall back to BroadcastChannel.
    console.debug(
      '[FabricAuth] Bridge: no opener — forwarding handoff via BroadcastChannel'
    );
    try {
      const channel = new BroadcastChannel(FABRIC_AUTH_CHANNEL);
      channel.postMessage(payload);
      channel.close();
    } catch {
      console.warn(
        '[FabricAuth] Bridge: BroadcastChannel unavailable — cannot forward handoff'
      );
      return false;
    }
  }

  // Scrub handoff params from URL
  if (window.history?.replaceState) {
    window.history.replaceState(
      null,
      '',
      window.location.pathname +
        window.location.search
          .replace(/[?&](?:verification_code|code|handoff|state)=[^&]*/g, '')
          .replace(/^\?$/, '')
    );
  }

  // Attempt to close popup (no-op for user-opened tabs).
  window.close();

  return true;
}
