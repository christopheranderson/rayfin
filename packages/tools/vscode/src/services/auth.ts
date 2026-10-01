/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// PROD is the only environment whose configuration is hardcoded in the
// extension. Any other environment (e.g. internal pre-production
// clouds) must be supplied by the user via the `rayfin.environmentConfig`
// setting.
//
// When `sessionProvider` is `"microsoft-sovereign-cloud"`, the user is
// also expected to configure VS Code's own `microsoft-sovereign-cloud.*`
// settings (`environment`, `customEnvironment`) so the sovereign-cloud
// auth provider knows which authority to target. Rayfin does not
// duplicate those fields.

const MS_SESSION_PROVIDER = 'microsoft';
const MS_SESSION_PROVIDER_SOVEREIGN_CLOUD = 'microsoft-sovereign-cloud';

/**
 * Fabric environment auth configuration. PROD is provided by the
 * extension; any other environment must be supplied by the user via the
 * `rayfin.environmentConfig` VS Code setting.
 */
export interface FabricEnvironmentConfig {
  /** Entra ID first-party app client ID to use when signing in. */
  clientId: string;
  /** OAuth scope for the Fabric API (e.g. `<resource>/.default`). */
  scope: string;
  /**
   * VS Code authentication session provider ID — `"microsoft"` for the
   * public Azure cloud, or `"microsoft-sovereign-cloud"` for non-public
   * authorities (which relies on the user's own
   * `microsoft-sovereign-cloud.customEnvironment` setting).
   */
  sessionProvider:
    | typeof MS_SESSION_PROVIDER
    | typeof MS_SESSION_PROVIDER_SOVEREIGN_CLOUD;
}

/** Built-in PROD Fabric environment config (public Azure cloud). */
const PROD_CONFIG: FabricEnvironmentConfig = {
  clientId: '02fe4832-64e1-42d2-a605-d14958774a2e',
  scope: 'https://analysis.windows.net/powerbi/api/.default',
  sessionProvider: MS_SESSION_PROVIDER,
};

/**
 * Read the currently selected Fabric environment name from VS Code
 * settings. This is a free-text label (e.g. `"PROD"`, `"PPE"`,
 * `"MyDevCloud"`); the name `"PROD"` is reserved and resolves to the
 * built-in production configuration.
 */
export function getCurrentEnvironment(): string {
  const raw = vscode.workspace
    .getConfiguration('rayfin')
    .get<string>('environment', 'PROD');
  return raw && raw.trim() ? raw : 'PROD';
}

/**
 * Resolve the environment config for the current environment setting.
 *
 * - If the environment name equals `"PROD"` (case insensitive), returns
 *   the built-in PROD config.
 * - Otherwise, reads `rayfin.environmentConfig` from VS Code settings
 *   and validates that required fields are present.
 *
 * @throws `Error` if a non-PROD environment is selected but
 *         `rayfin.environmentConfig` is missing or incomplete.
 */
function getEnvironmentConfig(): FabricEnvironmentConfig {
  const envName = getCurrentEnvironment();
  if (envName.toUpperCase() === 'PROD') {
    return PROD_CONFIG;
  }

  const userConfig = vscode.workspace
    .getConfiguration('rayfin')
    .get<Partial<FabricEnvironmentConfig>>('environmentConfig');

  if (
    !userConfig ||
    !userConfig.clientId ||
    !userConfig.scope ||
    !userConfig.sessionProvider
  ) {
    throw new Error(
      vscode.l10n.t(
        'rayfin.environment is set to "{0}" but rayfin.environmentConfig is missing or incomplete. Required fields: clientId, scope, sessionProvider. See the rayfin-ppe-config skill for details.',
        envName
      )
    );
  }

  if (
    userConfig.sessionProvider !== MS_SESSION_PROVIDER &&
    userConfig.sessionProvider !== MS_SESSION_PROVIDER_SOVEREIGN_CLOUD
  ) {
    throw new Error(
      vscode.l10n.t(
        'rayfin.environmentConfig.sessionProvider must be "{0}" or "{1}".',
        MS_SESSION_PROVIDER,
        MS_SESSION_PROVIDER_SOVEREIGN_CLOUD
      )
    );
  }

  return userConfig as FabricEnvironmentConfig;
}

/**
 * Return the VS Code authentication session provider ID for the
 * currently selected environment.
 */
export function getFabricSessionProvider(): string {
  return getEnvironmentConfig().sessionProvider;
}

/**
 * Build the full scopes array for `vscode.authentication.getSession()`.
 */
export function getFabricScopes(): string[] {
  const cfg = getEnvironmentConfig();
  return [
    `VSCODE_CLIENT_ID:${cfg.clientId}`,
    'VSCODE_TENANT:organizations',
    cfg.scope,
  ];
}

/**
 * Convenience wrapper around `vscode.authentication.getSession` that
 * automatically selects the correct session provider and scopes for the
 * current environment.
 */
export function getFabricSession(
  options: vscode.AuthenticationGetSessionOptions
): Promise<vscode.AuthenticationSession | undefined> {
  return Promise.resolve(
    vscode.authentication.getSession(
      getFabricSessionProvider(),
      getFabricScopes(),
      options
    )
  );
}
