import type { Auth, OpaqueSession } from '@microsoft/rayfin-auth';

import { embeddedFabricLogin } from './embeddedFabricLogin';
import {
  classifyExternalEmbed,
  isExternalEmbedScenario,
} from './externalEmbedClassification';
import {
  hasEmbeddedHandoffCompleted,
  isEmbeddedMode,
  tryResumeSession,
} from './fabricAuthHelpers';
import { hasFabricUserHint } from './fabricUserHint';
import type { FabricAuthOptions } from './types';

/**
 * Initializes embedded Fabric authentication if running inside an iframe
 * with `?fabricEmbedded=true`.
 *
 * Call this once at app startup (e.g., in a `useEffect` or initialization
 * routine). It is safe to call on page load — it never opens a popup or
 * new tab.
 *
 * **Behaviour:**
 * - Runs the one-shot externalEmbed classification handshake first. If a
 *   third-party parent acknowledges it, the externalEmbed flow proceeds even
 *   when the Fabric `fabricEmbedded` flag is absent.
 * - If neither the handshake is acknowledged **nor** `fabricEmbedded` is set
 *   (option or `?fabricEmbedded=true`), returns `null` (no-op). A standalone
 *   page with no parent frame reaches this immediately.
 * - When the host stamps a `?_fu=` hint, runs the standard resume waterfall
 *   (existing session → refresh token → handoff).
 * - When it does not (or in the externalEmbed scenario), skips resume on the
 *   first call per page load and goes straight to the handoff, preserving the
 *   protection against reusing a previously signed-in user's session.
 *
 * Apps that also support the popup flow should continue to call
 * {@link ensureSignedInWithFabric} from a user-gesture handler for the
 * non-embedded case.
 *
 * @param auth - The Auth instance.
 * @param options - Fabric authentication options.
 * @returns The authenticated session, or `null` if not in embedded mode.
 */
export async function initEmbeddedAuth(
  auth: Auth,
  options: FabricAuthOptions
): Promise<OpaqueSession | null> {
  const inEmbeddedMode = isEmbeddedMode(options);

  // One-shot externalEmbed classification handshake before any resume or
  // early-return decision. A successful acknowledgement means a third-party
  // parent is brokering external Entra — detected from the handshake alone,
  // independently of Fabric's `fabricEmbedded` flag. The handshake self-gates on
  // a parent frame, so a standalone page is an instant no-op and still returns
  // `null` below without opening anything.
  await classifyExternalEmbed();
  const externalEmbed = isExternalEmbedScenario();

  // Not embedded by either signal → nothing to do on page load.
  if (!externalEmbed && !inEmbeddedMode) {
    return null;
  }

  // Steps 1-2: existing session or refresh. Skipped on a legacy host (no `?_fu=` hint) until a
  // handoff has run this page load, because nothing server-side compared the session's identity
  // against the current Fabric user. The externalEmbed scenario always skips resume — the parent
  // brokers a fresh delegated handoff. See ensureSignedInWithFabric for the full reasoning.
  if (
    !externalEmbed &&
    (hasFabricUserHint() || hasEmbeddedHandoffCompleted())
  ) {
    const resumed = await tryResumeSession(auth);
    if (resumed) {
      return resumed;
    }
  } else {
    console.debug(
      '[FabricAuth:initEmbedded] Skipping session resume (externalEmbed scenario or no user hint) to avoid a stale cross-user session'
    );
  }

  // Step 3: postMessage handoff (no popup, no window.open)
  console.debug('[FabricAuth:initEmbedded] Starting postMessage handoff flow');
  try {
    await embeddedFabricLogin(auth, options);
  } catch (err) {
    console.warn('[FabricAuth:initEmbedded] Embedded login failed', err);
    return null;
  }

  const newSession = auth.getSession();
  if (newSession.isAuthenticated) {
    console.debug('[FabricAuth:initEmbedded] Session established');
    return newSession;
  }

  console.warn(
    '[FabricAuth:initEmbedded] Handoff completed but no session was established'
  );
  return null;
}
