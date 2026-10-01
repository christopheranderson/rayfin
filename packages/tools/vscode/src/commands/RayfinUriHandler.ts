/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DeployedCodeOrigin } from '@microsoft/rayfin-tools-common/_internal';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';

/**
 * Shape of the base64url-encoded JSON payload sent from the Fabric portal
 * via `vscode://microsoft.rayfin-vscode/open?payload=<base64url>`.
 */
export interface UriPayload {
  rayfinItemId?: string;
  artifactName?: string;
  fabricWorkspaceId?: string;
  environment?: string;
  /** Workload API endpoint URL (currently unused by the extension). */
  apiURL?: string;
  /** Fabric portal URL (currently unused by the extension). */
  portalURL?: string;
  /**
   * Optional portal-deployed template id (e.g. `gettingstartedauth`, `notesapp`).
   * When present, the Getting Started view pre-selects the matching sample
   * so `rayfin init` scaffolds the correct project.
   */
  templateId?: string;
  /** Origin of the currently-deployed backend code, if known. */
  deployedCodeOrigin?: DeployedCodeOrigin;
}

/**
 * Handles deep-link URIs from the Fabric portal.
 *
 * Decodes the base64url JSON payload and opens the Getting Started webview
 * with the payload data so the user can choose to open an existing project
 * or create a new one.
 */
export class RayfinUriHandler implements vscode.UriHandler {
  async handleUri(uri: vscode.Uri): Promise<void> {
    ext.outputChannel.appendLine(`URI received: ${uri.toString()}`);

    const params = new URLSearchParams(uri.query);
    const raw = params.get('payload');

    if (!raw) {
      ext.outputChannel.appendLine('URI missing payload parameter, ignoring.');
      return;
    }

    let payload: UriPayload;
    try {
      // RFC 4648 §5 base64url → standard base64
      const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
      const json = globalThis.atob(base64);
      payload = JSON.parse(json) as UriPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ext.outputChannel.appendLine(`Failed to decode URI payload: ${message}`);
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Could not decode the project link. Please try again.')
      );
      return;
    }

    ext.outputChannel.appendLine(
      `Decoded payload: artifactName=${payload.artifactName ?? '(none)'}, ` +
        `fabricItemId=${payload.rayfinItemId ?? '(none)'}, ` +
        `templateId=${payload.templateId ?? '(none)'}`
    );

    // Open the Getting Started webview with the URI payload
    await vscode.commands.executeCommand('rayfin.openGettingStarted', {
      payload,
    });
  }
}
