export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Auth strategy contract. Two implementations exist:
 * - {@link RayfinProxyAuthService} for local dev (system-browser login via the
 *   dev-server auth proxy).
 * - {@link RayfinFabricAuthService} for production / in-WebView Fabric login.
 */
export interface IAuthService {
  /**
   * Whether an interactive sign-in can succeed in this environment. `false`
   * only in production before the app has been wired to a Fabric workspace.
   */
  readonly canSignIn: boolean;

  /**
   * Silently restore an existing session on bootstrap. Never opens an
   * interactive login. Returns the user on success, or `null` to show login.
   */
  restoreSession(): Promise<AuthUser | null>;

  /** Interactive sign-in. Resolves with the signed-in user. */
  signIn(): Promise<AuthUser>;

  signOut(): Promise<void>;

  getCurrentUser(): Promise<AuthUser | null>;
}
