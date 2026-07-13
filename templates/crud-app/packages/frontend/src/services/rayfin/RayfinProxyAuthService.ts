import { createSessionFromTokenResponse } from '@microsoft/rayfin-auth/_internal';
import {
  fabricProxyLogout,
  hydrateFabricSessionFromProxy,
  hydrateFabricSessionFromProxyIfCached,
} from '@workspace-todo-app/local-dev';

import type { AuthUser, IAuthService } from '../interfaces/IAuthService';

import { getFabricProxyOptions } from './fabricConfig';
import { getRayfinClient } from './RayfinClientService';
import { userFromSession } from './session';

/**
 * Local-development auth. Delegates the real Fabric login to the dev-server
 * auth proxy, which opens the *system* browser (so passkeys / SSO work),
 * caches the raw Rayfin token, and returns it here. We then hydrate the SDK
 * session via the supported companion entry point. This is the custom
 * WebView-friendly flow used when running under `rayfin dev`.
 */
export class RayfinProxyAuthService implements IAuthService {
  readonly canSignIn = true;

  async restoreSession(): Promise<AuthUser | null> {
    const client = getRayfinClient();
    if (client.auth.getSession().isAuthenticated) return userFromSession();

    // Silently reuse a token captured during a previous system-browser login,
    // so a page refresh doesn't force the user through the browser flow again.
    const restored = await hydrateFabricSessionFromProxyIfCached(
      (token) => createSessionFromTokenResponse(client.auth, token),
      getFabricProxyOptions()
    );
    return restored ? userFromSession() : null;
  }

  async signIn(): Promise<AuthUser> {
    const client = getRayfinClient();
    await hydrateFabricSessionFromProxy(
      (token) => createSessionFromTokenResponse(client.auth, token),
      getFabricProxyOptions()
    );
    const user = userFromSession();
    if (!user) {
      throw new Error('System-browser sign-in did not establish a session.');
    }
    return user;
  }

  async signOut(): Promise<void> {
    await getRayfinClient().auth.signOut();
    // Evict the proxy's cached token so the next login re-runs the browser flow
    // instead of returning a stale session.
    await fabricProxyLogout().catch(() => {});
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    return userFromSession();
  }
}
