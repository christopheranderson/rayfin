/**
 * E2E environment configuration. All values come from pipeline variables
 * or local `.env` overrides — never hardcoded.
 */
export type AuthMode = 'sp' | 'user';

/**
 * Resolved auth mode for the current E2E run.
 * - `sp`: Service principal (CI default) — requires E2E_CLIENT_ID and E2E_CLIENT_SECRET.
 * - `user`: User credentials — relies on a prior `rayfin login` session.
 */
export const authMode: AuthMode =
  (process.env['E2E_AUTH_MODE'] as AuthMode) || 'sp';

export interface E2EConfig {
  authMode: AuthMode;
  environment: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  cliSource: 'source' | 'published';
}

/**
 * Fabric-specific E2E configuration for tests that target a Fabric workspace.
 */
export interface FabricE2EConfig extends E2EConfig {
  baseApiUrl: string;
  workspaceName: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        'Set it in the pipeline variables or a local .env file.'
    );
  }
  return value;
}

function envOrDefault(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export function resolveBaseApiUrl(environment: string): string {
  switch (environment) {
    case 'daily':
      return 'https://dailyapi.fabric.microsoft.com';
    case 'dxt':
      return 'https://dxtapi.fabric.microsoft.com';
    case 'prod':
      return 'https://api.fabric.microsoft.com';
    default:
      throw new Error(
        `Environment "${environment}" is not supported for CLI E2E tests. ` +
          'Only "daily", "dxt", and "prod" are supported as of now.'
      );
  }
}

/**
 * Load E2E configuration from environment variables.
 *
 * In `sp` mode, `E2E_CLIENT_ID` and `E2E_CLIENT_SECRET` are required.
 * In `user` mode, they are optional (authentication relies on a cached
 * `rayfin login` session).
 */
export function loadE2EConfig(): E2EConfig {
  const environment = requireEnv('E2E_ENVIRONMENT');
  const tenantId = requireEnv('E2E_TENANT_ID');
  const cliSource = (process.env['E2E_CLI_SOURCE'] ?? 'source') as
    | 'source'
    | 'published';

  if (authMode === 'sp') {
    return {
      authMode,
      environment,
      clientId: requireEnv('E2E_CLIENT_ID'),
      clientSecret: requireEnv('E2E_CLIENT_SECRET'),
      tenantId,
      cliSource,
    };
  }

  // User mode — SP credentials are optional
  return {
    authMode,
    environment,
    clientId: process.env['E2E_CLIENT_ID'] ?? '',
    clientSecret: process.env['E2E_CLIENT_SECRET'] ?? '',
    tenantId,
    cliSource,
  };
}

/**
 * Load Fabric-specific E2E configuration. In CI all values are required;
 * locally falls back to well-known defaults for interactive development.
 */
export function loadFabricE2EConfig(): FabricE2EConfig {
  const base = loadE2EConfig();

  return {
    ...base,
    baseApiUrl: resolveBaseApiUrl(base.environment),
    workspaceName: envOrDefault(
      'RAYFIN_E2E_WORKSPACE_NAME',
      'DO_NOT_DELETE_BAAS_E2E'
    ),
  };
}
