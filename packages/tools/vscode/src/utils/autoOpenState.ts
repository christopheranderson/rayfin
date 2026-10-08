/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

const STATE_KEY = 'rayfin.autoOpenDismissed';
const PENDING_URI_DEPLOY_KEY = 'rayfin.pendingUriDeploy';

type DismissedMap = Record<string, boolean>;

/**
 * Maps project ID → the Fabric workspace ID from the portal URI.
 * Stored alongside the boolean deploy flag so that when the auto-deploy
 * fires after a workspace reload we still know which workspace the portal
 * intended.
 */
type PendingDeployMap = Record<string, string | true>;

export function isAutoOpenDismissed(
  context: vscode.ExtensionContext,
  projectId: string
): boolean {
  const map = context.globalState.get<DismissedMap>(STATE_KEY, {});
  return map[projectId] === true;
}

export async function setAutoOpenDismissed(
  context: vscode.ExtensionContext,
  projectId: string,
  dismissed: boolean
): Promise<void> {
  const map = context.globalState.get<DismissedMap>(STATE_KEY, {});
  const updated = { ...map, [projectId]: dismissed };
  await context.globalState.update(STATE_KEY, updated);
}

/**
 * Record that a project was created via the URI handler ("Open in VS Code")
 * flow so the next workspace load can auto-deploy. The flag persists across
 * the workspace reload that happens when the new project folder is opened.
 *
 * When `fabricWorkspaceId` is provided it is stored so the auto-deploy can
 * target the exact workspace the portal intended, ignoring stale entries
 * in `rayfin/.deployments.json` from previous deployments.
 */
export async function setPendingUriDeploy(
  context: vscode.ExtensionContext,
  projectId: string,
  fabricWorkspaceId?: string
): Promise<void> {
  const map = context.globalState.get<PendingDeployMap>(
    PENDING_URI_DEPLOY_KEY,
    {}
  );
  const updated = { ...map, [projectId]: fabricWorkspaceId ?? true };
  await context.globalState.update(PENDING_URI_DEPLOY_KEY, updated);
}

/**
 * Non-consuming check for the pending-URI-deploy flag. Returns `true` if
 * the flag is set, without clearing it. Use {@link consumePendingUriDeploy}
 * to clear the flag once deployment has actually been triggered.
 */
export function hasPendingUriDeploy(
  context: vscode.ExtensionContext,
  projectId: string
): boolean {
  const map = context.globalState.get<PendingDeployMap>(
    PENDING_URI_DEPLOY_KEY,
    {}
  );
  return !!map[projectId];
}

/**
 * Check and clear the pending-URI-deploy flag for a project. Returns the
 * stored Fabric workspace ID when one was provided, otherwise `true` if the
 * flag was set without a workspace ID. Returns `false` when no flag exists.
 */
export async function consumePendingUriDeploy(
  context: vscode.ExtensionContext,
  projectId: string
): Promise<string | boolean> {
  const map = context.globalState.get<PendingDeployMap>(
    PENDING_URI_DEPLOY_KEY,
    {}
  );
  const value = map[projectId];
  if (!value) {
    return false;
  }
  const updated = { ...map };
  delete updated[projectId];
  await context.globalState.update(PENDING_URI_DEPLOY_KEY, updated);
  return value;
}
