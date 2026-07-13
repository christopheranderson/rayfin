import { ensureSignedInWithFabric } from '@microsoft/rayfin-auth-provider-fabric';

import type { AuthUser, IAuthService } from '../interfaces/IAuthService';

import { getFabricOptions } from './fabricConfig';
import { getRayfinClient } from './RayfinClientService';
import { userFromSession } from './session';

/**
 * Production / in-WebView auth. Uses the Fabric provider's postMessage-based
 * login (`ensureSignedInWithFabric`) directly against the SDK. When the app
 * hasn't been wired to a Fabric workspace yet ({@link getFabricOptions} returns
 * `null`), sign-in is disabled and the UI shows a "not configured" affordance.
 */
export class RayfinFabricAuthService implements IAuthService {
  get canSignIn(): boolean {
    return getFabricOptions() !== null;
  }

  async restoreSession(): Promise<AuthUser | null> {
    const client = getRayfinClient();
    if (client.auth.getSession().isAuthenticated) return userFromSession();

    const options = getFabricOptions();
    if (!options) return null;

    try {
      await ensureSignedInWithFabric(client.auth, options);
      return userFromSession();
    } catch {
      return null;
    }
  }

  async signIn(): Promise<AuthUser> {
    const options = getFabricOptions();
    if (!options) {
      throw new Error(
        'Fabric authentication is not configured yet. Run `npx rayfin up` to connect a workspace.'
      );
    }

    await ensureSignedInWithFabric(getRayfinClient().auth, options);
    const user = userFromSession();
    if (!user) {
      throw new Error(
        'Fabric authentication completed but no session was established.'
      );
    }
    return user;
  }

  async signOut(): Promise<void> {
    await getRayfinClient().auth.signOut();
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    return userFromSession();
  }
}
