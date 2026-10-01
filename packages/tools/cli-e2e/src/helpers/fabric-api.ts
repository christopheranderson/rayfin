/**
 * Fabric REST API helpers for E2E test artifact lifecycle.
 *
 * This module is vitest-free so it can be imported from both Vitest tests
 * and Playwright browser specs.
 */
import { authMode, resolveBaseApiUrl } from './env.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface FabricItem {
  id: string;
  displayName: string;
  type: string;
}

interface FabricWorkspace {
  id: string;
  displayName: string;
}

interface FabricItemsResponse {
  value: FabricItem[];
  continuationToken?: string;
}

interface FabricWorkspacesResponse {
  value: FabricWorkspace[];
}

interface CreateArtifactConfig {
  environment: string;
  clientId?: string;
  clientSecret?: string;
  tenantId: string;
  workspaceName: string;
  tag?: string;
}

interface DeleteArtifactConfig {
  environment: string;
  clientId?: string;
  clientSecret?: string;
  tenantId: string;
  workspaceId: string;
  artifactId: string;
}

const DEFAULT_CREATE_RETRY_DELAY_MS = 15_000;
const TEST_ARTIFACT_PREFIX = 'DO_NOT_DELETE_BAAS_SERVICE_PRINCIPAL_';
export const WORKSPACE_ITEM_LIMIT_ERROR =
  'The workspace has reached the maximum number of items allowed.';

export function getCreateRetryDelayMs(response: Response): number {
  const retryAfterMsHeader = response.headers.get('x-ms-retry-after-ms');
  const retryAfterMs = Number(retryAfterMsHeader);
  if (
    retryAfterMsHeader !== null &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
  ) {
    return retryAfterMs;
  }

  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterSeconds = Number(retryAfterHeader);
  if (
    retryAfterHeader !== null &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return retryAfterSeconds * 1000;
  }

  return DEFAULT_CREATE_RETRY_DELAY_MS;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Acquire an access token for the Fabric API using client_credentials flow.
 */
async function getSpAccessToken(
  tenantId: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://api.fabric.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to acquire access token (HTTP ${response.status}): ${text}`
    );
  }

  const data = (await response.json()) as TokenResponse;
  return data.access_token;
}

/**
 * Acquire an access token by reusing the cached user session from a prior
 * `rayfin login`. Uses the CLI's `getAuthenticatedToken()` which performs
 * silent MSAL token acquisition (or refresh) from the persisted cache.
 */
async function getUserAccessToken(): Promise<string> {
  const { getAuthenticatedToken } = await import('@microsoft/rayfin-cli/auth');
  const result = await getAuthenticatedToken();
  return result.token;
}

/**
 * Resolve an access token based on the current auth mode.
 */
async function getAccessToken(
  tenantId: string,
  clientId?: string,
  clientSecret?: string
): Promise<string> {
  if (authMode === 'user') {
    return getUserAccessToken();
  }

  if (!clientId || !clientSecret) {
    throw new Error(
      'E2E_CLIENT_ID and E2E_CLIENT_SECRET are required when E2E_AUTH_MODE=sp'
    );
  }
  return getSpAccessToken(tenantId, clientId, clientSecret);
}

export async function getFabricAccessToken(config: {
  tenantId: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<string> {
  return getAccessToken(config.tenantId, config.clientId, config.clientSecret);
}

/**
 * Get the workspace ID for a given workspace name.
 */
async function getWorkspaceId(
  baseApiUrl: string,
  token: string,
  workspaceName: string
): Promise<string> {
  const filterParam = encodeURIComponent(`name eq '${workspaceName}'`);
  const url = `${baseApiUrl}/v1/workspaces?$filter=${filterParam}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to list workspaces (HTTP ${response.status}): ${text}`
    );
  }

  const data = (await response.json()) as FabricWorkspacesResponse;
  const workspace = data.value.find((w) => w.displayName === workspaceName);

  if (!workspace) {
    throw new Error(
      `Workspace "${workspaceName}" not found. ` +
        `Available: ${data.value.map((w) => w.displayName).join(', ')}`
    );
  }

  return workspace.id;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Delete AppBackend items left behind by interrupted E2E runs.
 *
 * The CLI E2E workflow has exclusive access to its configured workspace while
 * this runs. Child SQL resources are removed asynchronously by Fabric, so the
 * deployment helper separately retries the exact capacity error during that
 * cleanup window.
 */
export async function cleanupStaleTestArtifacts(
  config: CreateArtifactConfig
): Promise<number> {
  const baseApiUrl = resolveBaseApiUrl(config.environment);
  const token = await getAccessToken(
    config.tenantId,
    config.clientId,
    config.clientSecret
  );
  const workspaceId = await getWorkspaceId(
    baseApiUrl,
    token,
    config.workspaceName
  );
  const itemsUrl = `${baseApiUrl}/v1/workspaces/${workspaceId}/items`;
  let pageUrl = `${itemsUrl}?type=AppBackend`;
  const staleArtifacts: FabricItem[] = [];

  while (pageUrl) {
    const response = await fetch(pageUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to list stale test artifacts (HTTP ${response.status}): ${text}`
      );
    }

    const page = (await response.json()) as FabricItemsResponse;
    staleArtifacts.push(
      ...page.value.filter(
        (item) =>
          item.type === 'AppBackend' &&
          item.displayName.startsWith(TEST_ARTIFACT_PREFIX)
      )
    );
    pageUrl = page.continuationToken
      ? `${itemsUrl}?type=AppBackend&continuationToken=${encodeURIComponent(page.continuationToken)}`
      : '';
  }

  for (const artifact of staleArtifacts) {
    const response = await fetch(`${itemsUrl}/${artifact.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(
        `Failed to delete stale artifact "${artifact.displayName}" (HTTP ${response.status}): ${text}`
      );
    }
  }

  if (staleArtifacts.length > 0) {
    console.log(
      `[fabric-api] Requested deletion of ${staleArtifacts.length} stale E2E artifact(s).`
    );
  }
  return staleArtifacts.length;
}

/**
 * Create a test artifact (AppBackend) in the specified Fabric workspace.
 *
 * The artifact name uses a unique per-run suffix (CI run id when available,
 * timestamp otherwise) to avoid collisions with still-deleting child SQL
 * resources from prior runs, since AppBackend deletion completes before its
 * SQLDatabase/SQL analytics endpoint cleanup finishes.
 */
export async function createTestArtifact(
  config: CreateArtifactConfig
): Promise<{
  artifactId: string;
  artifactName: string;
  workspaceId: string;
}> {
  const baseApiUrl = resolveBaseApiUrl(config.environment);
  const token = await getAccessToken(
    config.tenantId,
    config.clientId,
    config.clientSecret
  );

  const workspaceId = await getWorkspaceId(
    baseApiUrl,
    token,
    config.workspaceName
  );

  const runId = process.env['GITHUB_RUN_ID'] ?? Date.now();
  const runAttempt = process.env['GITHUB_RUN_ATTEMPT'] ?? '1';
  // Disambiguate CI matrix axes that share GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT.
  // Even though the axes are serialized, Fabric can reserve a deleted name
  // while its child resources are still being removed. Empty for local runs.
  const variant = process.env['E2E_RUN_VARIANT'];
  const variantSuffix = variant ? `_${variant}` : '';
  const tagSuffix = config.tag ? `_${config.tag}` : '';
  const artifactName = `${TEST_ARTIFACT_PREFIX}${runId}_${runAttempt}${variantSuffix}${tagSuffix}`;

  const url = `${baseApiUrl}/v1/workspaces/${workspaceId}/items`;

  const maxRetries = 5;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'AppBackend', displayName: artifactName }),
    });

    if (response.ok) {
      const created = (await response.json()) as FabricItem;
      return {
        artifactId: created.id,
        artifactName: created.displayName,
        workspaceId,
      };
    }

    const text = await response.text();

    const nameUnavailable =
      response.status === 409 &&
      text.includes('ItemDisplayNameNotAvailableYet');
    const capacityLimited =
      response.status === 429 ||
      (response.status === 400 && text.includes(WORKSPACE_ITEM_LIMIT_ERROR));

    if ((nameUnavailable || capacityLimited) && attempt < maxRetries) {
      const retryDelayMs = getCreateRetryDelayMs(response);
      const reason = capacityLimited
        ? 'Fabric capacity is temporarily unavailable'
        : `Artifact name "${artifactName}" is not available yet`;
      console.log(
        `[fabric-api] ${reason}, retrying in ${retryDelayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }

    lastError = new Error(
      `Failed to create artifact "${artifactName}" (HTTP ${response.status}): ${text}`
    );
    break;
  }

  throw lastError!;
}

/**
 * Delete a test artifact from a Fabric workspace.
 */
export async function deleteTestArtifact(
  config: DeleteArtifactConfig
): Promise<void> {
  const baseApiUrl = resolveBaseApiUrl(config.environment);
  const token = await getAccessToken(
    config.tenantId,
    config.clientId,
    config.clientSecret
  );

  const url = `${baseApiUrl}/v1/workspaces/${config.workspaceId}/items/${config.artifactId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to delete artifact "${config.artifactId}" (HTTP ${response.status}): ${text}`
    );
  }
}
