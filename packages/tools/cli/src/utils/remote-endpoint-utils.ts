import { ensureAuthenticated } from '../auth/index.js';
import { getFabricSettings } from '../config/constants.js';

import { getAmbientToken } from './ambient-env.js';
import {
  getActiveDeployment,
  listDeployments,
} from './deployments-registry.js';
import {
  type DeploymentEnvVars,
  readDeploymentEnvFile,
} from './env-fabric-utils.js';
import { findRayfinProjectRoot } from './project-utils.js';

// ---------------------------------------------------------------------------
// Base endpoint
// ---------------------------------------------------------------------------

/**
 * Resolve the active (or first registered) deployment from the local
 * deployment registry.
 *
 * @returns The full deployment env vars, or `null` if no valid deployment
 *          is configured.
 */
export function getActiveDeploymentEnvVars(): DeploymentEnvVars | null {
  try {
    const projectRoot = findRayfinProjectRoot(process.cwd(), {
      verbose: false,
      silent: true,
    });

    // Honour the active deployment in the registry first; only fall back to
    // the first registered deployment when none is marked active.  Picking
    // an arbitrary deployment here would ignore `active`, causing CLI
    // management calls (`up staticapp deploy`, `applyconfig`, etc.) to
    // target the wrong workspace whenever the user has more than one
    // deployment recorded.
    const active = getActiveDeployment(projectRoot);
    const workspaceName =
      active?.workspaceName ?? listDeployments(projectRoot)[0]?.workspaceName;
    if (!workspaceName) return null;

    const deployment = readDeploymentEnvFile(projectRoot, workspaceName);
    if (!deployment?.fabricWorkspaceId || !deployment?.rayfinItemId) {
      return null;
    }

    return deployment;
  } catch {
    return null;
  }
}

/**
 * Get the remote Rayfin item base endpoint URL from the deployment registry.
 *
 * Returns the **Fabric item (control-plane) endpoint**, built as:
 *
 * ```
 * {fabricApiBaseUrl}/workspaces/{fabricWorkspaceId}/appBackends/{rayfinItemId}
 * ```
 *
 * This is the correct base for all `/__private/*` management calls issued
 * by the CLI (deploy, applyconfig, projectRuntimeSettings, etc.) and matches
 * the `itemEndpoint` that `rayfin up` constructs via `RayfinItemManager`.
 *
 * Note: this is **not** `VITE_RAYFIN_API_URL`. That env var is the BaaS
 * workload/data-plane URL used by the built web app at runtime; it is not a
 * valid base for the CLI's private management API. Callers should use the
 * purpose-specific helpers below (e.g. {@link getRemoteApplyConfigUrl})
 * rather than appending paths manually.
 *
 * Non-interactive: if no active deployment is set but multiple deployments
 * are registered, falls back to the first registered deployment.
 *
 * @returns The base endpoint URL, or null if not configured / missing
 *          workspace or item id.
 */
export function getRemoteEndpoint(): string | null {
  const envVars = getActiveDeploymentEnvVars();
  if (!envVars) return null;

  const apiBaseUrl = getFabricSettings().fabricApiBaseUrl.replace(/\/$/, '');
  return `${apiBaseUrl}/workspaces/${envVars.fabricWorkspaceId}/appBackends/${envVars.rayfinItemId}`;
}

/**
 * Check if a remote endpoint is configured.
 * @returns true if a remote endpoint is available, false otherwise
 */
export function hasRemoteEndpoint(): boolean {
  return getRemoteEndpoint() !== null;
}

// ---------------------------------------------------------------------------
// Purpose-specific URL helpers
//
// Each helper constructs the full URL for a specific private management
// endpoint. When the PPE `/__private/` prefix is replaced by `/api/` in
// production, only these helpers need to change.
// ---------------------------------------------------------------------------

/**
 * URL for applying DAB (database) configuration.
 * @returns Full URL, or null if no remote endpoint is configured
 */
export function getRemoteApplyConfigUrl(): string | null {
  const base = getRemoteEndpoint();
  return base ? `${base}/__private/applyconfig` : null;
}

/**
 * URL for applying storage configuration.
 * @returns Full URL, or null if no remote endpoint is configured
 */
export function getRemoteStorageConfigUrl(): string | null {
  const base = getRemoteEndpoint();
  return base ? `${base}/__private/applystorageconfig` : null;
}

/**
 * URL for applying project runtime settings.
 * @returns Full URL, or null if no remote endpoint is configured
 */
export function getRemoteRuntimeSettingsUrl(): string | null {
  const base = getRemoteEndpoint();
  return base ? `${base}/__private/projectRuntimeSettings` : null;
}

/**
 * URL for deploying static content (webapp ZIP).
 * @returns Full URL, or null if no remote endpoint is configured
 */
export function getRemoteStaticDeployUrl(): string | null {
  const base = getRemoteEndpoint();
  return base ? `${base}/__private/webapp/deploy` : null;
}

/**
 * URL for deploying functions (multipart ZIP + metadata).
 * @returns Full URL, or null if no remote endpoint is configured
 */
export function getRemoteFunctionsDeployUrl(): string | null {
  const base = getRemoteEndpoint();
  return base ? `${base}/__private/functions/deploy` : null;
}

/**
 * URL for creating/updating a secret.
 * @returns Full URL, or null if no remote endpoint is configured
 */
export function getRemoteSecretsCreateUrl(): string | null {
  const base = getRemoteEndpoint();
  return base ? `${base}/__private/secrets/createsecret` : null;
}

/**
 * URL for polling the UDF workload's metadata endpoint.
 *
 * @param udfArtifactId - UDF artifact GUID returned by the deploy 202 response.
 * @returns Full metadata endpoint URL, or `null` if the workspace cannot
 *   be determined.
 */
export function getUdfMetadataUrl(udfArtifactId: string): string | null {
  const wsId = getActiveDeploymentEnvVars()?.fabricWorkspaceId;
  if (!wsId) return null;

  const apiBaseUrl = getFabricSettings().fabricApiBaseUrl.replace(/\/$/, '');
  return `${apiBaseUrl}/workspaces/${wsId}/userDataFunctions/${udfArtifactId}/__private/functions/metadata`;
}

/**
 * Acquire a Bearer authorization header for remote private endpoint calls.
 *
 * Acquires an AAD token via the secure credential chain and returns the
 * full `Bearer <token>` header value.
 */
export async function getRemoteAuthorizationHeader(
  scopes?: string[]
): Promise<string> {
  const envToken = getAmbientToken();
  if (envToken) {
    return `Bearer ${envToken}`;
  }

  const fabricToken = await ensureAuthenticated(scopes).catch((err) => {
    throw new Error(
      "Failed to acquire Fabric authentication token. Sign in with 'rayfin login'.",
      { cause: err }
    );
  });

  return `Bearer ${fabricToken.token}`;
}
