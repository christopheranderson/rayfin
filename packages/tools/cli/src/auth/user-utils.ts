export interface UserInfo {
  username: string;
  email: string;
  accountName: string;
}

/**
 * Get current user information from MSAL auth state or cached account.
 * @throws `Error` if user is not logged in via `rayfin login`
 */
export async function getCurrentUser(): Promise<UserInfo> {
  // First try the persisted auth state
  const { loadAuthState } = await import('./state.js');
  const state = await loadAuthState();

  if (state?.userPrincipalName) {
    const email = state.userPrincipalName;
    const username = email.split('@')[0];
    return {
      username,
      email,
      accountName: state.tenantId ?? '',
    };
  }

  // Fall back to MSAL cached account (use the shared singleton)
  const { getRayfinAuth } = await import('./index.js');
  const auth = await getRayfinAuth();
  const account = await auth.getAccount();

  if (account?.username) {
    const email = account.username;
    const username = email.split('@')[0];
    return {
      username,
      email,
      accountName: account.tenantId ?? '',
    };
  }

  throw new Error("Not logged in. Please run 'rayfin login' first.");
}

/**
 * Normalize username for Azure resource naming
 */
export function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, '');
}
