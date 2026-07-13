import type { AuthUser } from '../interfaces/IAuthService';

import { getRayfinClient } from './RayfinClientService';

/**
 * Map the current SDK auth session to an {@link AuthUser}, or `null` when there
 * is no authenticated session. Shared by every auth service so the shape of the
 * user object is defined in exactly one place.
 */
export function userFromSession(): AuthUser | null {
  const session = getRayfinClient().auth.getSession();
  if (!session.isAuthenticated || !session.user) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.email.split('@')[0],
  };
}
