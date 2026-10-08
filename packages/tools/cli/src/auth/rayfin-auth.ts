import {
  AccountInfo,
  ConfidentialClientApplication,
  PublicClientApplication,
  type AuthenticationResult,
  type Configuration,
  LogLevel,
  ResponseMode,
} from '@azure/msal-node';
import type { AuthSession } from '@microsoft/rayfin-tools-common/_internal/services/auth';

import { createCachePlugin } from './cache.js';
import {
  getDefaultAuthority,
  getFabricScopes,
  getRayfinClientId,
  getTenantAuthority,
} from './constants.js';
import { clearAuthState, loadAuthState, saveAuthState } from './state.js';

/** Result returned by {@link RayfinAuth.acquireToken} */
export interface TokenResult extends AuthSession {
  expiresOnTimestamp: number;
}

/** Options for constructing a {@link RayfinAuth} instance */
export interface RayfinAuthOptions {
  tenantId?: string;
  encryptionFallbackEnabled?: boolean;
  /** Service principal client ID. */
  clientId?: string;
  /** Service principal client secret. When set, enables the client credentials flow. */
  clientSecret?: string;
}

/**
 * Core authentication service for the Rayfin CLI.
 *
 * Supports two authentication modes:
 *
 * **User authentication (default):**
 * Wraps `@azure/msal-node` `PublicClientApplication` to provide:
 *   - Silent token acquisition from the persistent cache
 *   - Interactive browser-based login with local redirect
 *   - Device-code fallback for headless environments
 *   - Persisted auth state to `~/.rayfin/auth.json`
 *
 * **Service principal authentication:**
 * When constructed with `clientId` + `clientSecret`, uses
 * `ConfidentialClientApplication` with the OAuth2 client credentials
 * flow. No user interaction required — suitable for CI pipelines.
 * Credentials are persisted to `~/.rayfin/auth.json` (mode `0o600`)
 * by the `rayfin login --service-principal` command so subsequent
 * CLI commands can restore the session automatically via `getAuth()`.
 */
export class RayfinAuth {
  private pca: PublicClientApplication | null = null;
  private cca: ConfidentialClientApplication | null = null;
  private readonly authority: string;
  private readonly encryptionFallbackEnabled: boolean;
  private readonly clientId?: string;
  private readonly clientSecret?: string;

  constructor(options?: RayfinAuthOptions) {
    this.authority = options?.tenantId
      ? getTenantAuthority(options.tenantId)
      : getDefaultAuthority();
    this.encryptionFallbackEnabled =
      options?.encryptionFallbackEnabled ?? false;
    this.clientId = options?.clientId;
    this.clientSecret = options?.clientSecret;
  }

  /** Returns `true` when this instance is configured for service principal auth. */
  get isServicePrincipal(): boolean {
    return !!this.clientSecret;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Acquire a token for the given scopes.
   *
   * Flow: silent (cached account) → interactive (browser redirect with
   * local HTTP server, or device-code for headless environments).
   *
   * When `scopes` is omitted the resolved Fabric scope from
   * {@link getFabricScopes} is used. The scope is resolved per-call so
   * env-var overrides applied between construction and `acquireToken`
   * are honoured.
   */
  async acquireToken(
    scopes: string[] = getFabricScopes(),
    options?: { forceAccountSelect?: boolean; silentOnly?: boolean }
  ): Promise<TokenResult> {
    // Service principal: use client credentials flow (no user interaction)
    if (this.isServicePrincipal) {
      return this.acquireTokenByClientCredential(scopes);
    }

    const pca = await this.getPca();

    // Skip silent when the caller wants an explicit account picker
    if (!options?.forceAccountSelect) {
      const account = await this.getCachedAccount(pca);
      if (account) {
        try {
          const result = await pca.acquireTokenSilent({
            account,
            scopes,
          });
          return toTokenResult(result, 'user');
        } catch (err) {
          // Silent failed (expired / revoked) — fall through to interactive.
          // Stay quiet when the caller asked for silent-only acquisition: it
          // owns the failure and may be emitting structured JSON on stdout.
          if (!options?.silentOnly) {
            console.debug(
              `Silent token acquisition failed: ${(err as Error).message}`
            );
          }
        }
      }

      if (options?.silentOnly) {
        throw new Error(
          'Silent token acquisition failed and interactive login was not allowed'
        );
      }
    }

    // Interactive fallback
    const result = await this.acquireTokenInteractive(
      pca,
      scopes,
      options?.forceAccountSelect
    );
    await this.persistAccountInfo(result);
    return toTokenResult(result, 'user');
  }

  /**
   * Returns `true` if there is a cached account in the token cache.
   * For service principals, returns `true` since credentials are always
   * supplied at construction time.
   */
  async isLoggedIn(): Promise<boolean> {
    if (this.isServicePrincipal) return true;
    const pca = await this.getPca();
    const account = await this.getCachedAccount(pca);
    return account !== null;
  }

  /**
   * Returns the cached MSAL account or `null`.
   */
  async getAccount(): Promise<AccountInfo | null> {
    const pca = await this.getPca();
    return this.getCachedAccount(pca);
  }

  /**
   * Clear all auth state and the token cache.
   */
  async logout(): Promise<void> {
    if (!this.isServicePrincipal) {
      const pca = await this.getPca();
      const accounts = await pca.getTokenCache().getAllAccounts();
      for (const acct of accounts) {
        await pca.getTokenCache().removeAccount(acct);
      }
    }
    await clearAuthState();
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Build the MSAL authority config shared by both PCA and CCA.
   */
  private buildAuthorityConfig(): {
    authority: string;
    knownAuthorities?: string[];
  } {
    const authorityUrl = new URL(this.authority);
    const isDefaultHost =
      `${authorityUrl.protocol}//${authorityUrl.host}` ===
      'https://login.microsoftonline.com';
    const knownAuthorities = isDefaultHost ? undefined : [authorityUrl.host];
    return {
      authority: this.authority,
      ...(knownAuthorities ? { knownAuthorities } : {}),
    };
  }

  /**
   * Acquire a token via the OAuth2 client credentials flow (service
   * principal). No user interaction, no cache lookup — each call
   * requests a fresh token from Entra ID.
   */
  private async acquireTokenByClientCredential(
    scopes: string[]
  ): Promise<TokenResult> {
    const cca = await this.getCca();
    const result = await cca.acquireTokenByClientCredential({ scopes });
    if (!result) {
      throw new Error(
        'Client credentials flow returned null — verify the client ID and secret are correct'
      );
    }
    return toTokenResult(result, 'service_principal');
  }

  private async getCca(): Promise<ConfidentialClientApplication> {
    if (this.cca) return this.cca;

    const cachePlugin = await createCachePlugin({
      encryptionFallbackEnabled: this.encryptionFallbackEnabled,
    });

    const { authority, ...authorityRest } = this.buildAuthorityConfig();

    const config: Configuration = {
      auth: {
        clientId: this.clientId ?? getRayfinClientId(),
        clientSecret: this.clientSecret,
        authority,
        ...authorityRest,
      },
      cache: {
        cachePlugin,
      },
      system: {
        loggerOptions: {
          logLevel: LogLevel.Warning,
          loggerCallback: (level: LogLevel, message: string) => {
            if (level <= LogLevel.Warning) {
              console.warn(`[msal] ${message}`);
            }
          },
          piiLoggingEnabled: false,
        },
      },
    };

    this.cca = new ConfidentialClientApplication(config);
    return this.cca;
  }

  private async getPca(): Promise<PublicClientApplication> {
    if (this.pca) return this.pca;

    const cachePlugin = await createCachePlugin({
      encryptionFallbackEnabled: this.encryptionFallbackEnabled,
    });

    const { authority, ...authorityRest } = this.buildAuthorityConfig();

    const config: Configuration = {
      auth: {
        clientId: getRayfinClientId(),
        authority,
        ...authorityRest,
      },
      cache: {
        cachePlugin,
      },
      system: {
        loggerOptions: {
          logLevel: LogLevel.Warning,
          loggerCallback: (level: LogLevel, message: string) => {
            // Suppress MSAL info logs in normal CLI output
            if (level <= LogLevel.Warning) {
              console.warn(`[msal] ${message}`);
            }
          },
          piiLoggingEnabled: false,
        },
      },
    };

    this.pca = new PublicClientApplication(config);
    return this.pca;
  }

  private async getCachedAccount(
    pca: PublicClientApplication
  ): Promise<AccountInfo | null> {
    let accounts = await pca.getTokenCache().getAllAccounts();

    // When the CLI has a persisted "active user" (written by login /
    // acquireToken), honour it so that account switches from `rayfin
    // login` (which always shows the account picker) are respected even
    // when the MSAL cache contains multiple accounts.
    const state = await loadAuthState();
    if (state?.userPrincipalName) {
      const byUsername = accounts.find(
        (a: AccountInfo) =>
          a.username?.toLowerCase() === state.userPrincipalName?.toLowerCase()
      );
      if (byUsername) return byUsername;

      // The token cache may have been empty on the first query while the
      // cache-plugin was still loading. Re-query once before giving up.
      if (accounts.length === 0) {
        accounts = await pca.getTokenCache().getAllAccounts();
        const retry = accounts.find(
          (a: AccountInfo) =>
            a.username?.toLowerCase() === state.userPrincipalName?.toLowerCase()
        );
        if (retry) return retry;
      }
    }

    // No persisted preference — fall back to the first cached account.
    if (accounts.length > 0) {
      return accounts[0];
    }

    return null;
  }

  private async acquireTokenInteractive(
    pca: PublicClientApplication,
    scopes: string[],
    forceAccountSelect?: boolean
  ): Promise<AuthenticationResult> {
    try {
      // Prefer interactive browser login with local redirect
      return await pca.acquireTokenInteractive({
        scopes,
        responseMode: ResponseMode.FORM_POST,
        ...(forceAccountSelect && { prompt: 'select_account' }),
        openBrowser: async (url: string) => {
          const { exec } = await import('child_process');
          // Prefer $BROWSER (set by VS Code dev containers and many Linux
          // desktops) so the URL is forwarded to the host browser correctly.
          const browserEnv = process.env['BROWSER'];
          const command = browserEnv
            ? `"${browserEnv}" "${url}"`
            : process.platform === 'darwin'
              ? `open "${url}"`
              : process.platform === 'win32'
                ? `start "" "${url}"`
                : `xdg-open "${url}"`;
          exec(command);
        },
        successTemplate:
          '<h1>Authentication successful</h1><p>You can close this window.</p>',
        errorTemplate: '<h1>Authentication failed</h1><p>Error: {{error}}</p>',
      });
    } catch (err) {
      // Fall back to device code flow for headless environments
      console.log(
        `Browser login unavailable (${(err as Error).message}), using device code flow...`
      );
      const deviceResult = await pca.acquireTokenByDeviceCode({
        scopes,
        deviceCodeCallback: (response: { message: string }) => {
          console.log(response.message);
        },
      });
      if (!deviceResult) {
        throw new Error('Device code flow returned null');
      }
      return deviceResult;
    }
  }

  private async persistAccountInfo(
    result: AuthenticationResult
  ): Promise<void> {
    const claims = result.idTokenClaims as Record<string, unknown> | undefined;

    await saveAuthState({
      identityType: 'user',
      tenantId: (claims?.['tid'] as string) ?? result.tenantId,
      userPrincipalName:
        (claims?.['preferred_username'] as string) ?? result.account?.username,
      userName: (claims?.['name'] as string) ?? undefined,
    });
  }
}

function toTokenResult(
  result: AuthenticationResult,
  identityType: AuthSession['identityType']
): TokenResult {
  if (!result.accessToken) {
    throw new Error('Token acquisition succeeded but no access token returned');
  }

  return {
    token: result.accessToken,
    expiresOnTimestamp: result.expiresOn?.getTime() ?? 0,
    tenantId: result.tenantId,
    identityType,
  };
}
