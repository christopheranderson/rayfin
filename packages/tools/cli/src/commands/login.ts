import {
  RAYFIN_ENV_CONFIG_VARS,
  type EnvironmentConfig,
} from '@microsoft/rayfin-tools-common/_internal/env-config';
import { Command } from 'commander';

import { CliHandledError } from '../errors.js';
import { getAmbientTenantId, hasAmbientToken } from '../utils/ambient-env.js';
import { readDeploymentsRegistryState } from '../utils/deployments-registry.js';
import {
  emitJson,
  modeLog,
  modeError,
  resolveOutputMode,
  resolveRootOutputFlags,
} from '../utils/output-mode.js';
import { findRayfinProjectRoot } from '../utils/project-utils.js';

/**
 * Resolve the user-supplied `RAYFIN_*` environment-config overrides
 * for the current `rayfin login`. Returns the persisted
 * `environmentConfig` block to write on success, or `null` if nothing
 * should be persisted this run.
 *
 * Persistence is gated on the **authentication** group: a complete
 * authentication override is the only signal that the user wants to
 * pin an alternate Fabric environment across future invocations.
 *
 *   - **Auth group** (`RAYFIN_AUTHORITY_HOST`, `RAYFIN_CLIENT_ID`,
 *     `RAYFIN_FABRIC_SCOPE`) — intended for contributors only.
 *
 *     If **any** auth var is set, **all five** environment-config
 *     variables (3 auth + 2 endpoint) MUST be set, otherwise this
 *     function throws `CliHandledError` with the missing names. On
 *     success the function returns the full five-field block to
 *     persist to `~/.rayfin/auth.json`.
 *
 *   - **Endpoint-only path** (no auth vars set, any combination of
 *     `RAYFIN_FABRIC_API_URL` / `RAYFIN_FABRIC_PORTAL_URL` set, or
 *     none) — returns `null`. Nothing is persisted, so the user's
 *     existing PROD-or-persisted login is not silently re-targeted.
 *     Endpoint vars set in the shell or `rayfin/.env` still take
 *     effect for the current process via `process.env` (read by
 *     `getFabricSettings()` and friends); they just don't survive
 *     beyond this command.
 *
 * Reading from `process.env` (rather than commander options) keeps the
 * env vars as the single user-facing configuration surface and stays
 * consistent with downstream commands that already read the same vars.
 * `process.env` reflects both shell exports and any values the
 * bootstrap helper already hydrated from `~/.rayfin/auth.json`, so the
 * persisted block carries previously-persisted values the user did not
 * change this run.
 */
function resolveEnvOverrides(
  mode: ReturnType<typeof resolveOutputMode>
): EnvironmentConfig | null {
  const authVars = RAYFIN_ENV_CONFIG_VARS.filter((v) => v.group === 'auth');
  const setAuthCount = authVars.filter(({ envVar }) =>
    isSet(process.env[envVar])
  ).length;

  // No auth vars set → endpoint-only path. Don't persist; the user is
  // either running a one-off `RAYFIN_FABRIC_*=… rayfin login` or has
  // nothing extra exported at all.
  if (setAuthCount === 0) {
    return null;
  }

  // Auth path: any auth var set → require ALL five vars (3 auth + 2
  // endpoint). The endpoint vars are mandatory here because pinning an
  // alternate Fabric environment without also pinning its REST API and
  // portal URLs would silently fall back to the production endpoints
  // for the auth tenant.
  const missing = RAYFIN_ENV_CONFIG_VARS.filter(
    ({ envVar }) => !isSet(process.env[envVar])
  ).map(({ envVar }) => envVar);

  if (missing.length > 0) {
    const allVars = RAYFIN_ENV_CONFIG_VARS.map(({ envVar }) => envVar).join(
      ', '
    );
    modeError(
      mode,
      '❌ Authentication overrides require all five environment-config variables.'
    );
    modeError(mode, `   Missing: ${missing.join(', ')}`);
    modeError(
      mode,
      `   When any of the three authentication overrides is set, all five variables must be set: ${allVars}.`
    );
    throw new CliHandledError(
      new Error(
        `Authentication overrides require all five environment-config variables. Missing: ${missing.join(', ')}`
      )
    );
  }

  // All five present — build the persisted block.
  const out: EnvironmentConfig = {};
  for (const { envVar, configField } of RAYFIN_ENV_CONFIG_VARS) {
    out[configField] = process.env[envVar] as string;
  }
  return out;
}

function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * `rayfin login` — Interactive browser login via MSAL.
 *
 * Subcommands:
 *   `rayfin login status` — show current auth status
 */
export const loginCommand = new Command('login')
  .description('Sign in to the Rayfin platform')
  .option(
    '-t, --tenant <id>',
    'Provide your Tenant ID for Fabric to sign in to'
  )
  .option(
    '--service-principal',
    'Authenticate with service principal to Fabric using client credentials'
  )
  .option('-u, --client-id <id>', 'Client ID for service principal auth')
  .option(
    '-p, --client-secret <secret>',
    'Client secret for service principal auth'
  )
  .option(
    '--select',
    'Deprecated: the MSAL account picker is now always shown on login. This flag is accepted for backwards compatibility and has no additional effect.'
  )
  .option(
    '--encryption-fallback-enabled',
    "Allow plaintext token storage when the OS keychain is unavailable (some Linux distros, dev containers, Codespaces). Equivalent to Az CLI's same-named fallback. Required only when login fails with a keychain error.",
    false
  )
  .action(async (options, command: Command) => {
    const mode = resolveOutputMode({
      json: resolveRootOutputFlags(command).json,
    });

    if (hasAmbientToken()) {
      modeLog(
        mode,
        'Authentication is managed externally via RAYFIN_TOKEN. Skipping login.'
      );
      return;
    }

    if (options.servicePrincipal) {
      if (!options.clientId) {
        modeError(
          mode,
          '❌ --client-id is required for service principal authentication.'
        );
        throw new CliHandledError(
          new Error(
            '--client-id is required for service principal authentication'
          )
        );
      }
      if (!options.clientSecret) {
        modeError(
          mode,
          '❌ --client-secret is required for service principal authentication.'
        );
        throw new CliHandledError(
          new Error(
            '--client-secret is required for service principal authentication'
          )
        );
      }
      if (!options.tenant) {
        modeError(
          mode,
          '❌ --tenant is required for service principal authentication (client credentials require a specific tenant).'
        );
        throw new CliHandledError(
          new Error('--tenant is required for service principal authentication')
        );
      }
    } else if (options.clientId || options.clientSecret) {
      // Reject SP credentials without --service-principal to prevent
      // silently falling into the client credentials flow.
      modeError(
        mode,
        '❌ --client-id and --client-secret require the --service-principal flag.'
      );
      throw new CliHandledError(
        new Error(
          '--client-id and --client-secret require the --service-principal flag'
        )
      );
    }

    // Validate the env-config overrides BEFORE any state mutation or
    // network call. Throws CliHandledError if the user set any auth
    // var without setting all five vars. Returns the full five-field
    // block to persist when all five are set, or null when only
    // endpoint vars (or nothing) are set — in which case nothing is
    // persisted to ~/.rayfin/auth.json. The resolvers in
    // auth/constants.ts already read process.env, so we don't need to
    // mutate process.env here — the user already set it (or bootstrap
    // hydrated it from persisted state).
    const envOverrides = resolveEnvOverrides(mode);

    try {
      // Dynamic imports are intentional: they lazy-load native modules
      // (e.g. msal-node-extensions / keytar) so that merely importing the
      // command definition doesn't require native binaries.
      const { getFabricScopes } = await import('../auth/constants.js');
      const { RayfinAuth } = await import('../auth/rayfin-auth.js');
      const { loadAuthState, saveAuthState } = await import('../auth/state.js');

      const auth = new RayfinAuth({
        tenantId: options.tenant,
        encryptionFallbackEnabled: options.encryptionFallbackEnabled,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
      });

      if (auth.isServicePrincipal) {
        modeLog(mode, '🔑 Authenticating as service principal...');
      } else {
        modeLog(mode, '🔑 Opening browser for sign-in...');
      }

      // Always show the account picker on explicit `rayfin login` to avoid
      // silently reusing a cached account from another tenant. `--select`
      // remains accepted for compatibility.
      const { expiresOnTimestamp } = await auth.acquireToken(
        getFabricScopes(),
        {
          forceAccountSelect: true,
        }
      );

      if (auth.isServicePrincipal) {
        // Persist SP identity and credentials so subsequent commands can
        // transparently re-acquire tokens via client credentials flow.
        await saveAuthState({
          identityType: 'service_principal',
          tenantId: options.tenant,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          encryptionFallbackEnabled:
            options.encryptionFallbackEnabled || undefined,
          ...(envOverrides ? { environmentConfig: envOverrides } : {}),
        });

        modeLog(mode, '');
        modeLog(mode, '✅ Signed in as service principal');
        modeLog(mode, `   Client:    ${options.clientId}`);
        modeLog(mode, `   Tenant:    ${options.tenant}`);
        modeLog(
          mode,
          `   Expires:   ${new Date(expiresOnTimestamp).toLocaleString()}`
        );

        // Emit a minimal completion envelope so `rayfin --json login`
        // consumers always get something parseable on stdout. See PR
        // #1215 review thread.
        if (mode === 'json') {
          emitJson({
            status: 'ok',
            command: 'login',
            identityType: 'service_principal',
            clientId: options.clientId,
            tenant: options.tenant,
            expiresAt: new Date(expiresOnTimestamp).toISOString(),
          });
        }
      } else {
        const state = await loadAuthState();

        // Persist environmentConfig only when the user supplied a
        // complete environment override (all 5 RAYFIN_* vars) this run.
        if (envOverrides) {
          await saveAuthState({
            identityType: state?.identityType ?? 'user',
            ...(state ?? {}),
            environmentConfig: envOverrides,
          });
        }

        const upn = state?.userPrincipalName ?? 'unknown';
        const tenant = state?.tenantId ?? 'unknown';

        modeLog(mode, '');
        modeLog(mode, '✅ Signed in successfully');
        modeLog(mode, `   User:      ${upn}`);
        modeLog(mode, `   Tenant:    ${tenant}`);
        modeLog(
          mode,
          `   Expires:   ${new Date(expiresOnTimestamp).toLocaleString()}`
        );

        // Emit a minimal completion envelope so `rayfin --json login`
        // consumers always get something parseable on stdout. The
        // richer signed-in shape (account, endpoint, expiry source,
        // etc.) lives in `rayfin login status` and is intentionally
        // left out here — a follow-up will give `login status` its own
        // structured schema. See PR #1215 review thread.
        if (mode === 'json') {
          emitJson({
            status: 'ok',
            command: 'login',
            identityType: 'user',
            user: upn,
            tenant,
            expiresAt: new Date(expiresOnTimestamp).toISOString(),
          });
        }
      }
    } catch (error) {
      modeError(mode, `❌ Login failed: ${(error as Error).message}`);
      throw new CliHandledError(error);
    }
  });

/**
 * `rayfin login status` — Display current authentication status.
 */
loginCommand
  .command('status')
  .description('Display current authentication status')
  .action(async (_options: unknown, command: Command) => {
    const mode = resolveOutputMode({
      json: resolveRootOutputFlags(command).json,
    });

    if (hasAmbientToken()) {
      modeLog(mode, 'Signed in (ambient token via RAYFIN_TOKEN)');
      modeLog(mode, '   Identity:  external');
      modeLog(mode, '   Token:     provided via environment variable');
      if (mode === 'json') {
        emitJson({
          status: 'ok',
          command: 'login status',
          identityType: 'external',
          verification: 'endpoint-not-verified',
        });
      }
      return;
    }

    try {
      const { RayfinAuth } = await import('../auth/rayfin-auth.js');
      const { loadAuthState } = await import('../auth/state.js');
      const { getFabricSettings } = await import('../config/constants.js');

      const state = await loadAuthState();
      const auth = new RayfinAuth(
        state?.identityType === 'service_principal' &&
          state.clientId &&
          state.clientSecret
          ? {
              tenantId: state.tenantId,
              clientId: state.clientId,
              clientSecret: state.clientSecret,
              encryptionFallbackEnabled: state.encryptionFallbackEnabled,
            }
          : state?.tenantId
            ? {
                tenantId: state.tenantId,
                encryptionFallbackEnabled: state.encryptionFallbackEnabled,
              }
            : undefined
      );

      const loggedIn = await auth.isLoggedIn();

      if (!loggedIn) {
        modeLog(mode, '❌ Not signed in');
        modeLog(mode, "   Run 'rayfin login' to authenticate.");
        if (mode === 'json') {
          emitJson({
            status: 'not-signed-in',
            command: 'login status',
            recovery: "Run 'rayfin login' to authenticate.",
          });
        }
        return;
      }

      const account = auth.isServicePrincipal ? null : await auth.getAccount();
      const tenant = state?.tenantId ?? account?.tenantId;
      let projectRoot: string | undefined;
      try {
        projectRoot = findRayfinProjectRoot(process.cwd(), { silent: true });
      } catch {
        projectRoot = undefined;
      }
      const registry = projectRoot
        ? readDeploymentsRegistryState(projectRoot).registry
        : undefined;
      const configuredTenant =
        getAmbientTenantId() ??
        (registry?.active
          ? registry.deployments[registry.active]?.fabricTenantId
          : undefined);
      if (
        configuredTenant &&
        tenant &&
        configuredTenant.toLowerCase() !== tenant.toLowerCase()
      ) {
        throw new Error(
          `Sign-in tenant (${tenant}) differs from the configured tenant (${configuredTenant}).\n   Run 'rayfin login --tenant ${configuredTenant}' to authenticate with the configured tenant.`
        );
      }

      modeLog(mode, 'Signed in');
      modeLog(mode, `   Identity:  ${state?.identityType ?? 'user'}`);
      modeLog(
        mode,
        `   User:      ${state?.userPrincipalName ?? account?.username ?? 'unknown'}`
      );
      modeLog(mode, `   Tenant:    ${tenant ?? 'unknown'}`);
      // Surface the resolved Fabric API endpoint so contributors can
      // verify which environment they are signed into without naming a
      // specific environment in source. PROD shows the built-in default.
      modeLog(mode, `   Endpoint:  ${getFabricSettings().fabricApiBaseUrl}`);

      try {
        const { getFabricScopes } = await import('../auth/constants.js');
        const { expiresOnTimestamp } = await auth.acquireToken(
          getFabricScopes(),
          {
            silentOnly: true,
          }
        );
        modeLog(
          mode,
          `   Expires:   ${new Date(expiresOnTimestamp).toLocaleString()}`
        );
      } catch {
        modeLog(
          mode,
          '   Token:     expired or unavailable (re-login may be required)'
        );
      }

      if (mode === 'json') {
        emitJson({
          status: 'ok',
          command: 'login status',
          identityType: state?.identityType ?? 'user',
          tenant,
          configuredTenant,
          endpoint: getFabricSettings().fabricApiBaseUrl,
          verification: 'endpoint-not-verified',
        });
      }
    } catch (error) {
      if (mode === 'json') {
        emitJson({ status: 'error', error: (error as Error).message });
      }
      modeError(mode, `❌ Failed to check status: ${(error as Error).message}`);
      throw new CliHandledError(error);
    }
  });
