import type { Auth } from '@microsoft/rayfin-auth';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '@microsoft/rayfin-auth';
import { createSessionFromTokenResponse } from '@microsoft/rayfin-auth/_internal';
import { AuthError, assertBrowser } from '@microsoft/rayfin-lib';

import { FABRIC_AUTH_CHANNEL } from './bridgeFabricCallback';
import { buildBrokerUrl } from './brokerUrl';
import type { FabricAuthOptions } from './types';

/**
 * Initiates brokered authentication by opening the broker portal in a popup.
 *
 * **Must be called inside a user click handler** to avoid popup blockers.
 *
 * Opens the popup synchronously in the gesture (Safari/iOS block `window.open`
 * after an `await`) and delivers the PKCE challenge via the
 * `brokeredAuth.challenge` postMessage. On `brokeredAuth.handoff`, exchanges
 * the code for tokens and creates a session. `code_verifier` stays in closure.
 *
 * @param auth - Auth instance for token exchange.
 * @param options - Broker auth options (`returnOrigin` required).
 * @returns Resolves when the session is established.
 * @throws `AuthError` - On missing options, blocked popup, PKCE preparation or
 *   delivery failure (`PKCE_CHALLENGE_FAILED`, `CHALLENGE_DELIVERY_FAILED`), or
 *   auth failure.
 */
export async function initiateFabricLogin(
  auth: Auth,
  options: FabricAuthOptions
): Promise<void> {
  assertBrowser('initiateFabricLogin');
  // Validate required params
  if (!options.workspaceId) {
    throw new AuthError('workspaceId is required.', 'MISSING_WORKSPACE_ID');
  }
  if (!options.projectId) {
    throw new AuthError('projectId is required.', 'MISSING_PROJECT_ID');
  }
  if (!options.returnOrigin) {
    throw new AuthError(
      'returnOrigin is required for Fabric authentication.',
      'MISSING_RETURN_ORIGIN'
    );
  }
  if (!options.fabricPortalUrl) {
    throw new AuthError(
      'fabricPortalUrl is required for Fabric authentication.',
      'MISSING_FABRIC_PORTAL_URL'
    );
  }

  // Generate verifier + state synchronously so the popup can open in the user
  // gesture below. The S256 challenge is computed async (off the click path)
  // and delivered later via the `brokeredAuth.challenge` postMessage —
  // awaiting before `window.open` would trip Safari/iOS popup blocking.
  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const codeChallengePromise = generateCodeChallenge(codeVerifier);
  // Mark rejection handled for paths that skip handleReady; real handling is there.
  codeChallengePromise.catch(() => {});

  const expectedBrokerOrigin = new URL(options.fabricPortalUrl).origin;
  const brokerUrl = buildBrokerUrl(options);

  return new Promise<void>((resolve, reject) => {
    let fabricWindow: Window | null = null;
    let channel: BroadcastChannel | null = null;

    // 5-minute timeout — matches the backend's handoff code TTL.
    const TIMEOUT_MS = 5 * 60 * 1000;

    /** Whether the brokeredAuth.ready signal has been handled. */
    let readyHandled = false;

    function cleanup() {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('message', handleReady);
      channel?.close();
      channel = null;
      clearTimeout(timeoutId);
      if (fabricWindow && !fabricWindow.closed) {
        fabricWindow.close();
      }
    }

    /** Handles incoming brokeredAuth postMessage events. */
    function handleMessage(event: MessageEvent) {
      // Origin check is advisory — state + PKCE provide the real security.
      if (event.origin !== expectedBrokerOrigin) {
        console.info(
          `[FabricAuth] postMessage from origin="${event.origin}" (expected portal="${expectedBrokerOrigin}") — continuing (secured by state + PKCE)`
        );
      }

      if (!event.data || typeof event.data !== 'object') {
        console.debug('[FabricAuth] postMessage ignored: non-object payload');
        return;
      }

      const { type, state: msgState } = event.data;
      console.debug(
        `[FabricAuth] postMessage received: type=${String(type)}, stateMatch=${msgState === state}`
      );

      if (msgState !== state) {
        console.debug('[FabricAuth] postMessage ignored: state mismatch');
        return;
      }

      if (type === 'brokeredAuth.handoff') {
        console.debug(
          '[FabricAuth] Handling brokeredAuth.handoff — exchanging handoff code for tokens'
        );
        const { handoffCode } = event.data;
        cleanup();

        // redirectUri must match the value the broker used when creating the handoff code.
        const redirectUri = options.returnOrigin;
        auth
          .getAuthApi()
          .exchangeVerificationCode({
            verificationCode: handoffCode,
            codeVerifier,
            codeType: 'fabric_handoff',
            redirectUri,
          })
          .then(async (tokenResponse) => {
            console.debug(
              '[FabricAuth] Token exchange succeeded, creating session'
            );
            await createSessionFromTokenResponse(auth, tokenResponse);
            resolve();
          })
          .catch((err) => {
            console.warn('[FabricAuth] Token exchange failed', err);
            reject(err);
          });
      } else if (type === 'brokeredAuth.error') {
        console.warn(
          `[FabricAuth] Handling brokeredAuth.error — code=${String(event.data.error ?? 'unknown')}`
        );
        cleanup();
        reject(
          new AuthError(
            event.data.errorDescription || 'Fabric authentication failed.',
            event.data.error || 'FABRIC_AUTH_FAILED'
          )
        );
      }
    }

    const timeoutId = setTimeout(() => {
      console.warn('[FabricAuth] Broker handoff timed out after 5 minutes');
      cleanup();
      reject(
        new AuthError(
          'Fabric authentication timed out after 5 minutes. Please try again.',
          'FABRIC_AUTH_TIMEOUT'
        )
      );
    }, TIMEOUT_MS);

    /**
     * Handles `brokeredAuth.ready` from the broker extension.
     *
     * When the broker extension sends a ready signal the SDK responds with a
     * `brokeredAuth.challenge` containing the PKCE parameters.  Only the
     * first ready signal is handled — subsequent signals are ignored.
     *
     * The challenge is sent to `event.source` (the window that sent the ready
     * signal) rather than `fabricWindow`.  In Fabric the extension runs in a
     * cross-origin iframe inside the popup — `postMessage` sent to the
     * popup's top-level window does not propagate to child iframes.
     */
    async function handleReady(event: MessageEvent) {
      if (readyHandled) return;
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type !== 'brokeredAuth.ready') return;

      // Origin check is advisory — the extension iframe runs at a different
      // origin than the Fabric portal.  PKCE + state provide the real security.
      if (event.origin !== expectedBrokerOrigin) {
        console.info(
          `[FabricAuth] brokeredAuth.ready from origin="${event.origin}" (expected portal="${expectedBrokerOrigin}") — continuing (secured by state + PKCE)`
        );
      }

      readyHandled = true;
      window.removeEventListener('message', handleReady);

      // Challenge computed off the click path; await it here (almost always
      // already resolved by the time the broker signals ready).
      let codeChallenge: string;
      try {
        codeChallenge = await codeChallengePromise;
      } catch (err) {
        console.warn('[FabricAuth] Failed to compute PKCE code challenge', err);
        cleanup();
        reject(
          new AuthError(
            'Failed to prepare Fabric authentication.',
            'PKCE_CHALLENGE_FAILED'
          )
        );
        return;
      }

      const challengePayload = {
        type: 'brokeredAuth.challenge',
        returnOrigin: options.returnOrigin,
        codeChallenge,
        codeChallengeMethod: 'S256',
        state,
      };

      // Deliver the challenge. Guard postMessage: an opaque/sandboxed sender
      // reports event.origin === 'null' (an invalid targetOrigin that throws),
      // and this listener is async so a throw is swallowed by the DOM rather
      // than rejecting the outer promise — the flow would hang until timeout.
      try {
        // Normalize 'null'/empty origin to '*'; valid origins pass through.
        const targetOrigin =
          event.origin && event.origin !== 'null' ? event.origin : '*';

        // Reply to the window that sent the ready signal (the extension iframe).
        const source = event.source as Window | null;
        if (source) {
          source.postMessage(challengePayload, targetOrigin);
          console.debug(
            `[FabricAuth] Sent brokeredAuth.challenge to event.source (origin=${targetOrigin})`
          );
        } else if (fabricWindow && !fabricWindow.closed) {
          // Fallback when event.source is unavailable: post to the popup.
          fabricWindow.postMessage(challengePayload, expectedBrokerOrigin);
          console.debug(
            '[FabricAuth] Sent brokeredAuth.challenge to fabricWindow (event.source unavailable)'
          );
        }
      } catch (err) {
        console.warn('[FabricAuth] Failed to deliver PKCE challenge', err);
        cleanup();
        reject(
          new AuthError(
            'Failed to deliver Fabric authentication challenge.',
            'CHALLENGE_DELIVERY_FAILED'
          )
        );
      }
    }

    // Listen for brokeredAuth.ready from the popup (postMessage PKCE).
    window.addEventListener('message', handleReady);

    // Listen for handoff via postMessage and BroadcastChannel (legacy bridge).
    console.debug(
      '[FabricAuth] Registering postMessage listener for broker handoff'
    );
    window.addEventListener('message', handleMessage);

    try {
      channel = new BroadcastChannel(FABRIC_AUTH_CHANNEL);
      channel.onmessage = handleMessage;
      console.debug(
        '[FabricAuth] BroadcastChannel listener registered for backward-compat bridge'
      );
    } catch {
      console.debug(
        '[FabricAuth] BroadcastChannel not available — relying on postMessage only'
      );
    }

    // Open the chromeless SecureItemEmbed broker URL in a centered popup.
    const popupWidth = 600;
    const popupHeight = 700;
    const left = Math.round(
      window.screenX + (window.outerWidth - popupWidth) / 2
    );
    const top = Math.round(
      window.screenY + (window.outerHeight - popupHeight) / 2
    );
    fabricWindow = window.open(
      brokerUrl,
      'fabricAuth',
      `popup=yes,width=${popupWidth},height=${popupHeight},left=${left},top=${top}`
    );

    if (!fabricWindow) {
      cleanup();
      reject(
        new AuthError(
          'Failed to open Fabric sign-in page. ' +
            'Please allow popups for this site and try again.',
          'TAB_BLOCKED'
        )
      );
    }
  });
}
