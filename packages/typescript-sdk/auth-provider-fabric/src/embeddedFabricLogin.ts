import type { Auth } from '@microsoft/rayfin-auth';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '@microsoft/rayfin-auth';
import { createSessionFromTokenResponse } from '@microsoft/rayfin-auth/_internal';
import { AuthError, assertBrowser } from '@microsoft/rayfin-lib';

import { requestHandoff } from './PostMessageAuthTransport';
import {
  getPinnedParentOrigin,
  isExternalEmbedScenario,
} from './externalEmbedClassification';
import { markEmbeddedHandoffCompleted } from './fabricAuthHelpers';
import { hasFabricUserHint } from './fabricUserHint';
import type { FabricAuthOptions } from './types';

/**
 * Embedded-mode Fabric login — acquires a session via postMessage to the
 * parent Fabric Extension Host without opening a popup.
 *
 * 1. Discards any prior session when the host stamps no `?_fu=` hint (see below).
 * 2. Generates PKCE parameters in local variables (no `localStorage`).
 * 3. Sends `auth.requestHandoff` to the parent via `requestHandoff`.
 * 4. Receives the handoff code from the host's `AuthPlugin`.
 * 5. Exchanges the handoff code for tokens via `exchangeVerificationCode`.
 * 6. Creates a session via `createSessionFromTokenResponse`.
 *
 * The session is stored in the iframe's own `localStorage`.
 *
 * **Sign-out is conditional.** This function used to sign out unconditionally, as the only defence
 * against reusing a previous Fabric user's session — at the cost of destroying a valid session (and
 * the serve cookie sealed to it) on every single embedded load. A host that stamps `?_fu=` gives the
 * workload gate an identity to compare, so that defence is redundant and the sign-out is skipped. A
 * host that does not is indistinguishable from the pre-feature world, so the original behaviour is
 * kept for it rather than silently dropping the protection during version skew.
 *
 * @param auth - Auth instance for token exchange and session management.
 * @param options - Fabric auth options (`returnOrigin` required).
 * @throws `AuthError` - On missing options, transport failure, or token exchange error.
 */
export async function embeddedFabricLogin(
  auth: Auth,
  options: FabricAuthOptions
): Promise<void> {
  assertBrowser('embeddedFabricLogin');
  if (!options.returnOrigin) {
    throw new AuthError(
      'returnOrigin is required for embedded Fabric authentication.',
      'MISSING_RETURN_ORIGIN'
    );
  }

  // In the acked externalEmbed scenario there is no server-side serve-cookie
  // identity gate, so a `?_fu=` hint carries no comparison and is ignored: the
  // SDK always signs out before the handoff. On the normal Fabric path the
  // hint-gated sign-out below is unchanged.
  const externalEmbed = isExternalEmbedScenario();

  if (externalEmbed || !hasFabricUserHint()) {
    // Discard any prior session before the handoff. Errors are swallowed — the
    // stale token may already be invalid server-side, and the local clear that
    // signOut performs in its own catch is what matters.
    try {
      await auth.signOut();
    } catch (signOutError) {
      console.debug(
        '[FabricAuth:embedded] Pre-handoff signOut failed (non-fatal); local session has been cleared',
        signOutError
      );
    }
  }

  // PKCE in local variables only — not persisted to localStorage.
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  console.debug(
    '[FabricAuth:embedded] Requesting handoff from host via postMessage'
  );

  // NOTE: We intentionally do NOT pass fabricPortalUrl as the targetOrigin.
  // The SPA's window.parent is the Fabric *extension* iframe (AppViewMode),
  // not the portal itself.  The extension runs at a different origin than
  // fabricPortalUrl, and the child iframe cannot read window.parent.origin.
  // Security relies on UUID v4 requestId correlation + PKCE.
  // In the externalEmbed scenario the parent host has no per-app config, so it
  // is told which endpoint to broker against (`brokeredAuthorizeUrl`, derived
  // from the SDK's own Fabric capacity URL) and which artifact the token is for
  // (`artifactId`). The request is also pinned to the parent origin
  // acknowledged during classification. On the normal Fabric path all three are
  // omitted and the payload/target are unchanged.
  const result = await requestHandoff({
    callbackUrl: options.returnOrigin,
    codeChallenge,
    codeChallengeMethod: 'S256',
    state,
    ...(externalEmbed
      ? {
          brokeredAuthorizeUrl: auth
            .getAuthApi()
            .getBrokeredAuthorizeExternalUrl(),
          artifactId: options.projectId,
          targetOrigin: getPinnedParentOrigin(),
        }
      : {}),
  });

  // Validate state to prevent replay attacks.
  if (result.state !== state) {
    throw new AuthError(
      'State mismatch in embedded auth handoff response.',
      'STATE_MISMATCH'
    );
  }

  console.debug(
    '[FabricAuth:embedded] Handoff received, exchanging code for tokens'
  );

  const redirectUri = options.returnOrigin;
  const tokenResponse = await auth.getAuthApi().exchangeVerificationCode({
    verificationCode: result.handoffCode,
    codeVerifier,
    codeType: 'fabric_handoff',
    redirectUri,
  });

  await createSessionFromTokenResponse(auth, tokenResponse);
  markEmbeddedHandoffCompleted();
  console.debug('[FabricAuth:embedded] Session established');
}
