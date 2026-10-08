/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  deployStatusPath,
  extendedPropertiesPath,
} from '@microsoft/rayfin-tools-common/_internal';
import type { DeployStatusResponse } from '@microsoft/rayfin-tools-common/_internal';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  DEPLOY_CLIENT_VERSION_KEY,
  buildRuntimeSettingsPayload,
} from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import {
  preserveRecordedRuntimeSettings,
  translateStaticHostingAccessError,
  type RuntimeSettingsServices,
} from '@microsoft/rayfin-tools-common/_internal/services/runtime-settings';
import * as vscode from 'vscode';

import { ext } from '../../extensionVariables';
import { fileExists, readTextFile } from '../../utils/fs';
import type { StaticDeployResponse } from '../static/staticHosting';

import { FabricApiClient } from './client';
import { DEFAULT_FABRIC_SETTINGS, MONIKER_HEADER } from './constants';
import type { FabricSettings } from './constants';
import { DEPLOY_CLIENT_VERSION } from './deployClientVersion';
import { throwIfNotOk } from './http-client';

/** Retry configuration for API calls with exponential backoff. */
const RETRY_CONFIG = {
  maxAttempts: 5,
  baseDelay: 2000,
};

/**
 * Represents a Rayfin item (AppBackend) in Microsoft Fabric.
 */
export interface RayfinItem {
  id: string;
  displayName: string;
  description?: string;
  type: string;
  workspaceId: string;
  [key: string]: unknown;
}

/**
 * Client for Rayfin item (AppBackend) operations in Microsoft Fabric.
 */
export class RayfinItemClient extends FabricApiClient {
  private itemType: string;

  constructor(
    accessToken: string,
    verbose = false,
    fabricSettings?: FabricSettings
  ) {
    super(accessToken, verbose, fabricSettings);
    this.itemType =
      fabricSettings?.itemType ?? DEFAULT_FABRIC_SETTINGS.itemType;
  }

  /**
   * Creates a new Rayfin item (AppBackend) in the given workspace.
   */
  public async createRayfinItem(
    workspaceId: string,
    displayName: string
  ): Promise<RayfinItem> {
    return this.request<RayfinItem>(
      `/workspaces/${workspaceId}/items`,
      'POST',
      {
        type: this.itemType,
        displayName,
      }
    );
  }

  /**
   * Lists all Rayfin items (AppBackend) in a workspace and returns the one
   * matching the given {@link displayName}, if any.
   */
  public async getRayfinItemByName(
    workspaceId: string,
    displayName: string
  ): Promise<RayfinItem | undefined> {
    const response = await this.request<{ value: RayfinItem[] }>(
      `/workspaces/${workspaceId}/items?type=${this.itemType}`
    );

    return response.value.find(
      (item) => item.displayName.toLowerCase() === displayName.toLowerCase()
    );
  }

  /**
   * Gets an existing Rayfin item by name or creates a new one.
   *
   * If an item with the same name already exists the user is prompted via
   * VS Code to confirm reuse. When declined the method throws so the
   * caller can abort.
   */
  public async getOrCreateRayfinItem(
    workspaceId: string,
    displayName: string
  ): Promise<RayfinItem> {
    const existing = await this.getRayfinItemByName(workspaceId, displayName);

    if (existing) {
      ext.outputChannel.appendLine(
        `Rayfin item "${displayName}" already exists (ID: ${existing.id})`
      );

      const reuse = vscode.l10n.t('Reuse');
      const cancel = vscode.l10n.t('Cancel');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'A Rayfin item named "{0}" already exists in this workspace. Use it and update its configuration?',
          displayName
        ),
        reuse,
        cancel
      );

      if (choice !== reuse) {
        throw new Error(
          'Deployment cancelled — user declined to reuse the existing Rayfin item.'
        );
      }

      return existing;
    }

    ext.outputChannel.appendLine(
      `Creating new Rayfin item "${displayName}"...`
    );
    return this.createRayfinItem(workspaceId, displayName);
  }

  /**
   * Returns the Fabric REST API endpoint URL for this Rayfin item.
   *
   * Routes through the standard Fabric REST API (with Bearer auth),
   * which proxies to the workload backend. Callers append `/__private/`
   * paths for workload-specific operations.
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
    const response = await this.request<{
      extendedProperties: { BaaSEndpoint: string };
    }>(extendedPropertiesPath(workspaceId, artifactId));
    if (!response.extendedProperties?.BaaSEndpoint) {
      throw new Error(
        'BaaSEndpoint not found in extended properties. The item may still be provisioning.'
      );
    }
    return response.extendedProperties;
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

  /**
   * Applies Rayfin Data configuration to the item endpoint.
   */
  public async applyConfig(
    workspaceId: string,
    artifactId: string,
    configData: string,
    force: boolean
  ): Promise<string> {
    const itemEndpoint = this.getRayfinItemEndpoint(workspaceId, artifactId);
    const payload = {
      ConfigData: configData,
      Force: force,
    };

    const response = await fetch(`${itemEndpoint}/__private/applyconfig`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.getAuthorizationHeader(),
        [MONIKER_HEADER]: artifactId,
      },
      body: JSON.stringify(payload),
    });

    const responseData = await throwIfNotOk(
      response,
      'Rayfin Data server responded with error'
    );

    return responseData;
  }

  /**
   * Retrieves the publishable key for a deployed Rayfin item.
   */
  public async getPublishableKey(
    workspaceId: string,
    artifactId: string
  ): Promise<string> {
    const itemEndpoint = this.getRayfinItemEndpoint(workspaceId, artifactId);
    const resp = await fetch(`${itemEndpoint}/__private/publishable-key`, {
      method: 'GET',
      headers: {
        Authorization: this.getAuthorizationHeader(),
        [MONIKER_HEADER]: artifactId,
      },
    });

    const body = await throwIfNotOk(resp, 'Could not retrieve publishable key');
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.publishableKey === 'string') return obj.publishableKey;
      }
    } catch {
      // Not JSON — return raw text
    }
    return body.trim();
  }

  /**
   * Retrieves the publishable key with retry/exponential backoff.
   */
  public async retrievePublishableKey(
    workspaceId: string,
    artifactId: string
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      ext.outputChannel.appendLine(
        `[publishable-key] Attempt ${attempt}/${RETRY_CONFIG.maxAttempts}`
      );

      try {
        return await this.getPublishableKey(workspaceId, artifactId);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt < RETRY_CONFIG.maxAttempts) {
        const delay = Math.pow(2, attempt - 1) * RETRY_CONFIG.baseDelay;
        ext.outputChannel.appendLine(
          `[publishable-key] Waiting ${delay}ms before retry...`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error('Failed to retrieve publishable key');
  }

  /**
   * Posts runtime settings to the workload endpoint.
   *
   * The body is assembled by the shared {@link buildRuntimeSettingsPayload},
   * so the extension and the CLI send the same wire shape and declare the same
   * client-identity key. Without that entry the workload rejects a
   * static-hosting write with HTTP 400 once
   * `BaaS_EnableStaticHostingAccessControl` is enabled for the tenant, and the
   * remedy it names — upgrade the CLI — is no help to someone deploying from
   * VS Code.
   *
   * Builder-facing `services.staticHosting.assetAccess` is translated by the
   * shared payload builder to the workload's `anonymousAccess` field; the
   * extension does not author either value.
   */
  public async applyRuntimeSettings(
    workspaceId: string,
    artifactId: string,
    services: RayfinConfig['services']
  ): Promise<void> {
    const itemEndpoint = this.getRayfinItemEndpoint(workspaceId, artifactId);
    const resp = await fetch(
      `${itemEndpoint}/__private/projectRuntimeSettings`,
      {
        method: 'POST',
        headers: {
          Authorization: this.getAuthorizationHeader(),
          'Content-Type': 'application/json',
          [MONIKER_HEADER]: artifactId,
        },
        body: JSON.stringify(
          buildRuntimeSettingsPayload({
            services,
            clientVersion: DEPLOY_CLIENT_VERSION,
          })
        ),
      }
    );

    await throwIfNotOk(
      resp,
      'Runtime settings sync failed',
      translateStaticHostingAccessError
    );
  }

  /**
   * Update redirect URIs without restating the access posture.
   *
   * A content-only deploy changes where the app may be loaded from, not who may
   * load it, so this reads what the workload recorded and overlays only `auth`.
   * Posting the local `services` would let a working copy that has drifted from
   * the last full `up` silently republish a stale posture.
   */
  public async updateHostingRedirectSettings(
    workspaceId: string,
    artifactId: string,
    services: RayfinConfig['services']
  ): Promise<void> {
    const settingsUrl = `${this.getRayfinItemEndpoint(workspaceId, artifactId)}/__private/projectRuntimeSettings`;
    const headers = {
      Authorization: this.getAuthorizationHeader(),
      'Content-Type': 'application/json',
      [MONIKER_HEADER]: artifactId,
    };

    const currentText = await throwIfNotOk(
      await fetch(settingsUrl, { headers }),
      'Current runtime settings retrieval failed'
    );
    const recorded = (
      JSON.parse(currentText) as { serviceSettings?: RuntimeSettingsServices }
    ).serviceSettings;
    if (!recorded) {
      throw new Error(
        'Current runtime settings response did not include serviceSettings'
      );
    }

    const resp = await fetch(settingsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        preserveRecordedRuntimeSettings({
          recorded,
          services,
          packageVersions: {
            [DEPLOY_CLIENT_VERSION_KEY]: DEPLOY_CLIENT_VERSION,
          },
        })
      ),
    });

    await throwIfNotOk(
      resp,
      'Runtime settings update failed',
      translateStaticHostingAccessError
    );
  }

  /**
   * Apply Rayfin Data config with exponential backoff retry and
   * destructive-change confirmation.
   */
  public async applyDataConfigWithRetry(
    dataConfigUri: vscode.Uri,
    workspaceId: string,
    artifactId: string
  ): Promise<void> {
    let lastError: Error | null = null;
    let force = false;

    for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.pow(2, attempt) * RETRY_CONFIG.baseDelay;
          ext.outputChannel.appendLine(
            `Retry attempt ${attempt + 1}/${RETRY_CONFIG.maxAttempts}, delay: ${delay}ms`
          );
          await new Promise((r) => setTimeout(r, delay));
        }

        await this.applyConfigToServer(
          dataConfigUri,
          workspaceId,
          artifactId,
          force
        );
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Detect destructive changes — prompt user
        if (!force && lastError.message.toLowerCase().includes('destructive')) {
          const forceLabel = vscode.l10n.t('Apply Anyway');
          const cancelLabel = vscode.l10n.t('Cancel');
          const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Destructive schema changes detected. Applying may result in data loss. Continue?'
            ),
            forceLabel,
            cancelLabel
          );

          if (choice === forceLabel) {
            force = true;
            // Replay the current attempt with force — the for-loop's
            // post-increment cancels out this decrement.
            attempt--;
            continue;
          }

          throw new Error(
            'Up cancelled — user declined destructive schema changes.'
          );
        }

        ext.outputChannel.appendLine(
          `Apply attempt ${attempt + 1} failed: ${lastError.message}`
        );

        if (attempt === RETRY_CONFIG.maxAttempts - 1) break;
      }
    }

    if (lastError) {
      ext.outputChannel.appendLine(
        `Database apply failed: ${lastError.message}`
      );
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Database configuration apply failed. You can manually run 'rayfin up db apply' later."
        )
      );
    }
  }

  private async applyConfigToServer(
    configUri: vscode.Uri,
    workspaceId: string,
    artifactId: string,
    force: boolean
  ): Promise<void> {
    const startTime = Date.now();
    const itemEndpoint = this.getRayfinItemEndpoint(workspaceId, artifactId);

    ext.outputChannel.appendLine(
      'Applying Rayfin Data configuration to server...'
    );

    if (!(await fileExists(configUri))) {
      throw new Error(
        `Rayfin Data configuration file not found: ${configUri.toString(true)}`
      );
    }

    ext.outputChannel.appendLine(
      `Reading config from: ${configUri.toString(true)}`
    );

    const configContent = await readTextFile(configUri);

    try {
      JSON.parse(configContent);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON in configuration file: ${errorMessage}`);
    }

    ext.outputChannel.appendLine(
      `Applying configuration to endpoint: ${itemEndpoint}`
    );
    if (force) {
      ext.outputChannel.appendLine(
        'Using force mode — Rayfin Data will accept configuration that may result in data loss'
      );
    }

    try {
      const responseData = await this.applyConfig(
        workspaceId,
        artifactId,
        configContent,
        force
      );
      const duration = Date.now() - startTime;

      ext.outputChannel.appendLine('Configuration applied successfully!');
      if (responseData.trim()) {
        ext.outputChannel.appendLine(`Server response: ${responseData}`);
      }
      ext.outputChannel.appendLine(`Apply completed in ${duration}ms`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        throw new Error(
          `Cannot connect to Rayfin server at ${itemEndpoint}/__private/applyconfig`
        );
      }
      throw error;
    }
  }

  /**
   * Deploy a ZIP package of static content to the workload endpoint.
   */
  public async deployStaticContent(
    workspaceId: string,
    artifactId: string,
    zipData: Uint8Array
  ): Promise<StaticDeployResponse> {
    const itemEndpoint = this.getRayfinItemEndpoint(workspaceId, artifactId);
    const url = `${itemEndpoint}/__private/webapp/deploy`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.getAuthorizationHeader(),
        'Content-Type': 'application/zip',
        'Content-Length': String(zipData.byteLength),
        [MONIKER_HEADER]: artifactId,
      },
      body: zipData,
    });

    const text = await throwIfNotOk(resp, 'Static deploy failed');
    let parsed: StaticDeployResponse;
    try {
      parsed = JSON.parse(text) as StaticDeployResponse;
    } catch {
      throw new Error(`Unexpected deploy response: ${text.substring(0, 200)}`);
    }
    if (!parsed.success && parsed.errorMessage) {
      throw new Error(`Static deploy failed: ${parsed.errorMessage}`);
    }
    return parsed;
  }
}
