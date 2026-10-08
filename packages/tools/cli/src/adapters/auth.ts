/**
 * CLI implementation of the {@link Auth} adapter.
 *
 * Wraps the CLI's existing {@link ensureAuthenticated} flow (MSAL silent →
 * interactive, with an `RAYFIN_TOKEN` ambient-token fast path), exposing it
 * through the narrow `getToken(scopes)` seam universal code depends on.
 *
 * Acquisition mode stays host-decided (silent-then-interactive) as the
 * interface documents; when a non-interactive/CI "fail instead of prompt"
 * path is first needed, it is added as an additive options arg rather than
 * guessed here.
 */
import type {
  Auth,
  AuthToken,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { AuthSession } from '@microsoft/rayfin-tools-common/_internal/services/auth';

import { ensureAuthenticated } from '../auth/index.js';

/**
 * MSAL-backed {@link Auth} implementation for the CLI host.
 *
 * `scopes` is forwarded to {@link ensureAuthenticated}; an empty array lets
 * the underlying flow resolve the default Fabric scope (honoring any
 * `RAYFIN_FABRIC_SCOPE` override applied at startup).
 */
export const cliAuth: Auth = {
  async getToken(scopes: readonly string[]): Promise<AuthToken> {
    const result = await ensureAuthenticated(
      scopes.length > 0 ? [...scopes] : undefined
    );
    return {
      token: result.token,
      expiresOnTimestamp: result.expiresOnTimestamp,
    };
  },
};

/** Create an {@link Auth} capability fixed to one resolved command session. */
export function authFromSession(session: AuthSession): Auth {
  return {
    async getToken(): Promise<AuthToken> {
      return {
        token: session.token,
        expiresOnTimestamp: session.expiresOnTimestamp,
      };
    },
  };
}
