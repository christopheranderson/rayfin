import {
  deployStatusPath,
  extendedPropertiesPath,
} from '@microsoft/rayfin-tools-common/_internal';
import type { DeployStatusResponse } from '@microsoft/rayfin-tools-common/_internal';
import inquirer from 'inquirer';

import { getFabricSettings } from '../../config/constants.js';
import { fabricFetch, throwIfNotOk } from '../../utils/http-client.js';
import { HttpError, withRetry } from '../../utils/retry-utils.js';

import FabricApiClient from './client.js';

export class RayfinItemReuseDeclinedError extends Error {
  public constructor(displayName: string) {
    super(
      `Deployment cancelled. The existing Rayfin item "${displayName}" was not reused.`
    );
    this.name = 'RayfinItemReuseDeclinedError';
  }
}

/**
 * The item exists but its workload has not finished provisioning, so no
 * `BaaSEndpoint` is published yet. Transient: retried by
 * {@link RayfinItemManager.getExtendedProperties}.
 */
export class WorkloadNotReadyError extends Error {
  public constructor() {
    super(
      'BaaSEndpoint not found in extended properties. The item may still be provisioning. ' +
        "Wait a few seconds, then run 'rayfin up' again."
    );
    this.name = 'WorkloadNotReadyError';
  }
}

/**
 * The workspace does not list an item by the expected display name yet.
 *
 * Raised only while reconciling a create whose outcome is unknown, so the poll
 * keeps waiting out Fabric's control-plane consistency delay rather than
 * concluding the item was never created.
 */
export class ItemNotVisibleYetError extends Error {
  public constructor(displayName: string) {
    super(`Rayfin item "${displayName}" is not listed in the workspace yet.`);
    this.name = 'ItemNotVisibleYetError';
  }
}

/**
 * Whether a failed extended-properties read is worth retrying.
 *
 * Retries the workload-provisioning race only: the not-ready sentinel above,
 * server-side faults (5xx), and throttling (429). Deterministic client errors
 * — a bad item ID (404), a token without access (401/403) — are returned to
 * the caller immediately, because retrying cannot change their outcome and
 * doing so would stall the user behind five backoff waits.
 */
export function isTransientWorkloadError(error: Error): boolean {
  if (error instanceof WorkloadNotReadyError) {
    return true;
  }
  if (error instanceof HttpError) {
    return error.statusCode >= 500 || error.statusCode === 429;
  }
  return false;
}

export interface GetOrCreateRayfinItemOptions {
  nonInteractive?: boolean;
  /**
   * When true, treat the caller as having explicitly consented to reusing an
   * existing same-named remote item. Skips the interactive prompt and the
   * non-interactive guard. Wired up to the `--yes` / `-y` flag on `rayfin up`.
   */
  confirmReuse?: boolean;
  workspaceDisplayName?: string;
}

/**
 * Represents a Fabric item returned by the Items API.
 */
export interface FabricItem {
  id: string;
  displayName: string;
  description?: string;
  type: string;
  workspaceId: string;
  [key: string]: any;
}

/**
 * Secret record to send to the workload endpoint.
 */
export interface SecretWriteRequest {
  name: string;
  value: string;
  description?: string;
}

/**
 * Response payload from the workload when a secret is written.
 */
export interface SecretWriteResponse {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Secret record returned from the workload when listing secrets.
 * Does not include the secret value.
 */
export interface SecretListItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplySecretsToRemoteEndpointOptions {
  itemEndpoint: string;
  secrets: SecretWriteRequest[];
  getAuthorizationHeader: () => Promise<string>;
  log?: (...args: any[]) => void;
}

export interface GetSecretsFromRemoteEndpointOptions {
  itemEndpoint: string;
  getAuthorizationHeader: () => Promise<string>;
  log?: (...args: any[]) => void;
}

export interface DeleteSecretFromRemoteEndpointOptions {
  itemEndpoint: string;
  name: string;
  getAuthorizationHeader: () => Promise<string>;
  log?: (...args: any[]) => void;
}

/**
 * Manages Rayfin item (AppBackend) lifecycle operations in Microsoft Fabric.
 *
 * Follows the existing CLI pattern where each Fabric resource type has its
 * own manager class extending {@link FabricApiClient}.
 */
export class RayfinItemManager extends FabricApiClient {
  /**
   * Lists items in a workspace, following pagination. Pass `type` to
   * filter server-side via the Items API's `?type=` query param.
   */
  public async listItems(
    workspaceId: string,
    type?: string
  ): Promise<FabricItem[]> {
    const query = type ? `?type=${encodeURIComponent(type)}` : '';
    return this.listAllPages<FabricItem>(
      `/workspaces/${workspaceId}/items${query}`
    );
  }

  /**
   * Creates a new Rayfin item (AppBackend) in the given workspace.
   *
   * The workload ignores any definition/creationPayload — only `type` and
   * `displayName` are required.  Creation is synchronous (HTTP 201).
   *
   * Recovers from transient failures. The create POST can answer 5xx while the
   * workspace is busy, failing a first deploy for a reason that clears on its
   * own within seconds.
   *
   * A create is not idempotent and a 5xx does not say whether it ran, so the
   * POST is sent exactly once. An ambiguous failure hands off to
   * {@link reconcileAmbiguousCreate}, which resolves the outcome by name
   * instead of writing again. Replaying the POST would be unsafe even when the
   * item is not yet listed: Fabric's control plane is eventually consistent, so
   * a create that did succeed can stay invisible for a moment, and a second
   * POST then fails the deploy outright with a display-name conflict.
   */
  public async createRayfinItem(
    workspaceId: string,
    displayName: string
  ): Promise<FabricItem> {
    try {
      return await this.request<FabricItem>(
        `/workspaces/${workspaceId}/items`,
        'POST',
        {
          type: getFabricSettings().itemType,
          displayName,
        },
        // Reported by whichever path below terminates, so an error the
        // reconcile recovers from never reaches the user.
        { suppressErrorLog: true }
      );
    } catch (error) {
      const failure = error as Error;
      // A response that is not transient is a definite answer (bad request,
      // no permission): the create did not happen and will not start working.
      if (!isTransientWorkloadError(failure)) {
        this.logRequestError(failure);
        throw failure;
      }
      return this.reconcileAmbiguousCreate(workspaceId, displayName, failure);
    }
  }

  /**
   * Resolve a create whose outcome is unknown, without writing again.
   *
   * Polls the workspace for the display name, absorbing the control-plane
   * consistency delay that can hide an item the failed POST did create. A name
   * that never appears is reported as the original failure: the create most
   * likely never ran, and `rayfin up` is safe to re-run, whereas posting again
   * here risks a second item.
   */
  private async reconcileAmbiguousCreate(
    workspaceId: string,
    displayName: string,
    failure: Error
  ): Promise<FabricItem> {
    try {
      return await withRetry(
        async () => {
          const existing = await this.getRayfinItemByName(
            workspaceId,
            displayName
          );
          if (!existing) {
            throw new ItemNotVisibleYetError(displayName);
          }
          this.debugDiagnostic(
            'up.item',
            `create reported a transient failure but the item exists: ${existing.id}`
          );
          return existing;
        },
        {
          label: `reconcile-item-${displayName}`,
          verbose: (...args: unknown[]) => {
            const message = args.map((arg) => String(arg)).join(' ');
            this.verboseLog(message);
            this.debugDiagnostic('up.item', message);
          },
          shouldRetry: (error) =>
            error instanceof ItemNotVisibleYetError ||
            isTransientWorkloadError(error),
        }
      );
    } catch {
      this.logRequestError(failure);
      throw failure;
    }
  }

  /**
   * Lists all Rayfin items (AppBackend) in a workspace and returns the one
   * matching the given {@link displayName}, if any.
   */
  public async getRayfinItemByName(
    workspaceId: string,
    displayName: string
  ): Promise<FabricItem | undefined> {
    const items = await this.listAllPages<FabricItem>(
      `/workspaces/${workspaceId}/items?type=${getFabricSettings().itemType}`
    );

    return items.find(
      (item) => item.displayName.toLowerCase() === displayName.toLowerCase()
    );
  }

  /**
   * Gets an existing Rayfin item by name or creates a new one.
   *
   * If an item with the same name already exists, the user must explicitly
   * confirm reuse. Non-interactive callers fail rather than overwriting a
   * previously-unmapped remote item without confirmation, unless
   * `confirmReuse` is set to indicate explicit consent (e.g. `--yes`).
   */
  public async getOrCreateRayfinItem(
    workspaceId: string,
    displayName: string,
    options: GetOrCreateRayfinItemOptions = {}
  ): Promise<FabricItem> {
    const nonInteractive = options.nonInteractive ?? false;
    const confirmReuse = options.confirmReuse ?? false;
    const workspaceLabel =
      options.workspaceDisplayName ?? 'the target workspace';

    const existing = await this.getRayfinItemByName(workspaceId, displayName);

    if (existing) {
      if (confirmReuse) {
        return existing;
      }

      if (nonInteractive) {
        throw new Error(
          `A Rayfin item named "${displayName}" already exists in "${workspaceLabel}" (ID: ${existing.id}), but this project has not been deployed there before. Run \`rayfin up\` in an interactive terminal to confirm reuse, pass \`--yes\` to auto-accept, or choose a different project name or workspace.`
        );
      }

      console.log(
        `A Rayfin item named "${displayName}" already exists in "${workspaceLabel}" (ID: ${existing.id}).`
      );
      console.log('This project has not been deployed here before.');

      const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Use the existing item and overwrite its config?',
          default: false,
        },
      ]);

      if (!confirm) {
        throw new RayfinItemReuseDeclinedError(displayName);
      }

      return existing;
    }

    if (!nonInteractive) {
      console.log(`Creating new Rayfin item "${displayName}"...`);
    }
    return this.createRayfinItem(workspaceId, displayName);
  }

  /**
   * Retrieves a single Fabric item by its ID.
   *
   * Returns `undefined` when the item does not exist (404).
   */
  public async getFabricItemById(
    workspaceId: string,
    itemId: string
  ): Promise<FabricItem | undefined> {
    try {
      return await this.request<FabricItem>(
        `/workspaces/${workspaceId}/items/${itemId}`,
        'GET',
        undefined,
        { suppressErrorLog: true }
      );
    } catch (error) {
      // Treat 404 as "not found" rather than a hard failure
      if (error instanceof HttpError && error.statusCode === 404) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Constructs the Fabric item endpoint URL for private management API calls.
   *
   * Uses the standard Fabric REST API base URL. Callers append specific
   * `__private/` paths (e.g. `/__private/applyconfig`); see
   * `remote-endpoint-utils.ts` for the purpose-specific helpers.
   *
   * URL pattern:
   * ```
   * https://{fabricApiBaseUrl}/workspaces/{workspaceId}/appBackends/{artifactId}
   * ```
   */
  public getRayfinItemEndpoint(
    workspaceId: string,
    artifactId: string
  ): string {
    return `${this.apiBaseUrl}/workspaces/${workspaceId}/appBackends/${artifactId}`;
  }

  /**
   * Retrieves extended properties for a Rayfin item, including the
   * fully-resolved BaaS endpoint URL.
   *
   * Uses the standard Fabric REST API with Bearer (AAD) authentication.
   *
   * @returns The `extendedProperties` object from the response, which
   *          includes a `BaaSEndpoint` key with the complete workload URL.
   */
  public async getExtendedProperties(
    workspaceId: string,
    artifactId: string
  ): Promise<{ BaaSEndpoint: string }> {
    // A Rayfin item's workload is provisioned asynchronously after the item
    // itself is created, so the first `up` for a brand-new item races that
    // provisioning: the service answers with a 5xx (or a 200 whose
    // `extendedProperties` has no `BaaSEndpoint` yet) until the workload is
    // ready. Both shapes are transient and clear within seconds, so they are
    // retried here rather than surfaced as a hard failure on the user's very
    // first deployment.
    try {
      return await withRetry(
        async () => {
          const response = await this.request<{
            extendedProperties: { BaaSEndpoint: string };
          }>(
            extendedPropertiesPath(workspaceId, artifactId),
            'GET',
            undefined,
            // `request` writes to the error sink before this retry can
            // classify the failure. Legacy `up` and hydrateDeploymentFromFabric
            // build this manager with console output, so without this an
            // attempt that a later one recovers from would still print
            // "Error making Fabric API request" — noise for a deployment that
            // then succeeds. Attempts stay visible in diagnostics below.
            { suppressErrorLog: true }
          );
          if (!response.extendedProperties?.BaaSEndpoint) {
            throw new WorkloadNotReadyError();
          }
          return response.extendedProperties;
        },
        {
          label: `extended-properties-${artifactId}`,
          verbose: (...args: unknown[]) => {
            const message = args.map((arg) => String(arg)).join(' ');
            this.verboseLog(message);
            this.debugDiagnostic('up.target', message);
          },
          shouldRetry: isTransientWorkloadError,
        }
      );
    } catch (error) {
      // Terminal: either retries were exhausted or the failure was never
      // retryable. Restore the single error-sink message that per-attempt
      // suppression withheld, then let the caller handle the error as before.
      this.logRequestError(error);
      throw error;
    }
  }

  /**
   * Retrieves the deployment status for a Rayfin item, including
   * the active deployment state and deployed code origin.
   *
   * Uses the standard Fabric REST API with Bearer (AAD) authentication.
   */
  public async getDeployStatus(
    workspaceId: string,
    artifactId: string
  ): Promise<DeployStatusResponse> {
    return this.request<DeployStatusResponse>(
      deployStatusPath(workspaceId, artifactId)
    );
  }
}

export default RayfinItemManager;

/**
 * Applies secrets to the remote workload endpoint.
 * Handles auth acquisition, retries, and response parsing.
 */
export async function applySecretsToRemoteEndpoint({
  itemEndpoint,
  secrets,
  getAuthorizationHeader,
  log,
}: ApplySecretsToRemoteEndpointOptions): Promise<SecretWriteResponse[]> {
  const writeLog = log ?? (() => {});
  const responses: SecretWriteResponse[] = [];

  if (secrets.length === 0) {
    return responses;
  }

  const authorizationHeader = await getAuthorizationHeader();

  for (const secret of secrets) {
    await withRetry(
      async () => {
        const secretsUrl = `${itemEndpoint}/__private/secrets`;
        writeLog(`[secrets] POST`, secretsUrl, `name=${secret.name}`);

        const resp = await fabricFetch(secretsUrl, {
          method: 'POST',
          headers: {
            Authorization: authorizationHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(secret),
        });
        writeLog(`[secrets] Response: ${resp.status} ${resp.statusText}`);
        const respBody = await throwIfNotOk(
          resp,
          `Failed to write secret "${secret.name}"`
        );

        const parsed =
          typeof respBody === 'string' ? JSON.parse(respBody) : respBody;
        responses.push(parsed as SecretWriteResponse);
      },
      { label: `secret-write-${secret.name}`, verbose: writeLog }
    );
  }

  return responses;
}

/**
 * Retrieves all secrets from the remote workload endpoint.
 * Returns only metadata (name, timestamps), not the secret values.
 * Handles auth acquisition and retries.
 */
export async function getSecretsFromRemoteEndpoint({
  itemEndpoint,
  getAuthorizationHeader,
  log,
}: GetSecretsFromRemoteEndpointOptions): Promise<SecretListItem[]> {
  const writeLog = log ?? (() => {});

  const authorizationHeader = await getAuthorizationHeader();

  return withRetry(
    async () => {
      const secretsUrl = `${itemEndpoint}/__private/secrets`;
      writeLog(`[secrets] GET`, secretsUrl);

      const resp = await fabricFetch(secretsUrl, {
        method: 'GET',
        headers: {
          Authorization: authorizationHeader,
          'Content-Type': 'application/json',
        },
      });
      writeLog(`[secrets] Response: ${resp.status} ${resp.statusText}`);
      const respBody = await throwIfNotOk(resp, 'Failed to retrieve secrets');

      const parsed =
        typeof respBody === 'string' ? JSON.parse(respBody) : respBody;

      // Ensure we always return an array
      return Array.isArray(parsed) ? parsed : parsed.value || [];
    },
    { label: 'secret-list', verbose: writeLog }
  );
}

/**
 * Deletes a secret from the remote workload endpoint.
 *
 * Calls the `POST .../secrets/{name}/delete` route rather than a bare
 * `DELETE .../secrets/{name}`: the Fabric appbackends `__private` public-API
 * passthrough only forwards GET and POST, so a bare DELETE is rejected by
 * the gateway with a 404 before it ever reaches the controller. The
 * `DELETE .../secrets/{name}` route does exist server-side but only works
 * for direct/in-cluster callers, not the CLI.
 *
 * Succeeds with 204 No Content and no response body. A 404 means either
 * the secret does not exist or secret management is not enabled for this
 * item — the two cases are indistinguishable from the response alone, so
 * callers should word user-facing messages accordingly.
 *
 * A 404 is treated as terminal (not retried) since it reflects a
 * deterministic state, not a transient failure.
 */
export async function deleteSecretFromRemoteEndpoint({
  itemEndpoint,
  name,
  getAuthorizationHeader,
  log,
}: DeleteSecretFromRemoteEndpointOptions): Promise<void> {
  const writeLog = log ?? (() => {});

  const authorizationHeader = await getAuthorizationHeader();

  await withRetry(
    async () => {
      const deleteUrl = `${itemEndpoint}/__private/secrets/${encodeURIComponent(name)}/delete`;
      writeLog(`[secrets] POST`, deleteUrl);

      const resp = await fabricFetch(deleteUrl, {
        method: 'POST',
        headers: {
          Authorization: authorizationHeader,
        },
      });
      writeLog(`[secrets] Response: ${resp.status} ${resp.statusText}`);
      await throwIfNotOk(resp, `Failed to delete secret "${name}"`);
    },
    {
      label: `secret-delete-${name}`,
      verbose: writeLog,
      shouldRetry: (error) =>
        !(error instanceof HttpError && error.statusCode === 404),
    }
  );
}
