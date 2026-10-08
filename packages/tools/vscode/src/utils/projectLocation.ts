/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Return a URI for the default parent directory for new Rayfin projects
 * (`~/RayfinApps` on desktop, workspace-relative on web).
 *
 * Works across all VS Code hosts:
 * - Desktop macOS/Linux: reads `process.env.HOME`
 * - Desktop Windows: reads `process.env.USERPROFILE`
 * - Web (vscode.dev / Codespaces with remote FS): falls back to the first
 *   workspace folder so the URI uses the correct remote scheme
 *
 * Returns `undefined` when no reasonable default can be determined (e.g. web
 * host with no workspace open).
 */
export function getDefaultProjectParentUri(): vscode.Uri | undefined {
  // Desktop Node host — process global is available
  if (typeof process !== 'undefined' && process.env) {
    const homePath = process.env.HOME ?? process.env.USERPROFILE;
    if (homePath) {
      return vscode.Uri.joinPath(vscode.Uri.file(homePath), 'RayfinApps');
    }
  }

  // Web host — use the open workspace folder as the parent
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return vscode.Uri.joinPath(workspaceFolder.uri, 'RayfinApps');
  }

  return undefined;
}
