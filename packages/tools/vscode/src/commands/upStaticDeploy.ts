/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addAllowedRedirectUri } from '@microsoft/rayfin-tools-common/_internal/config';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';
import { getFabricSession } from '../services/auth';
import { getFabricSettings } from '../services/fabric/constants';
import { RayfinItemClient } from '../services/fabric/rayfinItem';
import { WorkspaceClient } from '../services/fabric/workspace';
import {
  updateRayfinConfig,
  loadRayfinConfig,
  loadEnvironmentVariables,
} from '../services/rayfin/config';
import {
  extractTenantIdFromToken,
  resolveDeploymentFromEnvFiles,
  writeDeploymentEnvFile,
} from '../services/rayfin/envFabric';
import { findRayfinProjectRoot } from '../services/rayfin/projectUtils';
import {
  formatBytes,
  logStatic,
  packageStaticFolder,
  validateStaticFolder,
} from '../services/static/staticHosting';
import { runStaticBuild } from '../utils/staticBuild';

/**
 * Deploy only static content to an already-deployed Rayfin item.
 * Equivalent to the CLI's `rayfin up staticapp deploy`.
 */
export async function upStaticDeploy(): Promise<void> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Deploy Static Content'),
      cancellable: true,
    },
    async (progress, token) => {
      try {
        await runStaticDeploy(progress, token);
      } catch (error) {
        if (token.isCancellationRequested) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t('Static deploy cancelled.')
          );
          return;
        }
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        ext.outputChannel.appendLine(`Static deploy failed: ${errorMessage}`);
        if (error instanceof Error && error.stack) {
          ext.outputChannel.appendLine(error.stack);
        }
        ext.outputChannel.show(true);
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Static deploy failed: {0}', errorMessage)
        );
      }
    }
  );
}

async function runStaticDeploy(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<void> {
  // ── Load config ───────────────────────────────────────────────────
  progress.report({
    message: vscode.l10n.t('Loading project configuration...'),
  });

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error(
      'No workspace folder is open. Open a Rayfin project folder first.'
    );
  }

  const workspaceRootUri = workspaceFolders[0].uri;
  const projectRootUri = await findRayfinProjectRoot(workspaceRootUri);
  const rayfinConfig = await loadRayfinConfig(projectRootUri);

  if (!rayfinConfig) {
    throw new Error(
      'Could not load rayfin.yml configuration. Ensure your project contains rayfin/rayfin.yml.'
    );
  }

  // Resolve Fabric settings from project .env overrides
  const envVars = await loadEnvironmentVariables({
    projectRoot: projectRootUri,
  });
  const fabricSettings = getFabricSettings(Object.fromEntries(envVars));

  const staticConfig = rayfinConfig.services.staticHosting;
  if (!staticConfig?.enabled) {
    throw new Error(
      "Static hosting is not enabled in rayfin.yml. Set 'services.staticHosting.enabled: true' and re-run."
    );
  }

  // Read deployment data from the deployment registry
  const envDeployment = await resolveDeploymentFromEnvFiles(projectRootUri);
  const deployment = envDeployment?.deployment;
  if (
    !deployment?.fabricApiUrl ||
    !deployment?.fabricWorkspaceId ||
    !deployment?.fabricItemId
  ) {
    throw new Error(
      "No remote deployment found. Run 'Rayfin: Deploy to Fabric' first."
    );
  }

  const deployedWorkspaceName = envDeployment?.workspaceName;

  throwIfCancelled(token);

  // ── Prompt to skip build ──────────────────────────────────────────
  let skipBuild = false;
  if (staticConfig.buildCommand) {
    const runBuild = vscode.l10n.t('Build & Deploy');
    const skipBuildOption = vscode.l10n.t('Deploy Only (skip build)');
    const choice = await vscode.window.showQuickPick(
      [runBuild, skipBuildOption],
      {
        placeHolder: vscode.l10n.t('How would you like to deploy?'),
        title: vscode.l10n.t('Static Content Deployment'),
      }
    );
    if (!choice) {
      throw new vscode.CancellationError();
    }
    skipBuild = choice === skipBuildOption;
  }

  throwIfCancelled(token);

  // ── Run build command ─────────────────────────────────────────────
  if (!skipBuild && staticConfig.buildCommand) {
    progress.report({
      message: vscode.l10n.t('Building static content...'),
    });

    const buildCwd = vscode.Uri.joinPath(
      projectRootUri,
      staticConfig.root || '.'
    );
    const exitCode = await runStaticBuild(staticConfig.buildCommand, buildCwd);
    if (exitCode !== 0) {
      throw new Error(
        'Static build command failed. Check the terminal output for details.'
      );
    }
    logStatic('Build command completed');
  }

  throwIfCancelled(token);

  // ── Validate ──────────────────────────────────────────────────────
  progress.report({
    message: vscode.l10n.t('Validating static content...'),
  });

  const validation = await validateStaticFolder(projectRootUri, staticConfig);
  if (!validation.exists) {
    throw new Error(validation.message || 'Static folder not found');
  }
  if (validation.empty) {
    throw new Error('Static folder is empty. Build your project first.');
  }

  logStatic(
    `Folder validated: ${validation.fileCount} files, ${formatBytes(validation.totalSizeBytes)}`
  );

  throwIfCancelled(token);

  // ── Package ───────────────────────────────────────────────────────
  progress.report({
    message: vscode.l10n.t('Packaging static content...'),
  });

  const zipData = await packageStaticFolder(validation.resolvedUri);
  logStatic(`Packaged: ${formatBytes(zipData.byteLength)} compressed`);

  throwIfCancelled(token);

  // ── Authenticate ──────────────────────────────────────────────────
  progress.report({ message: vscode.l10n.t('Authenticating...') });

  const session = await getFabricSession({ createIfNone: true });

  if (!session) {
    throw new Error('Authentication was cancelled.');
  }

  const rayfinItemClient = new RayfinItemClient(
    session.accessToken,
    false,
    fabricSettings
  );

  throwIfCancelled(token);

  // ── Deploy ────────────────────────────────────────────────────────
  progress.report({
    message: vscode.l10n.t('Deploying static content...'),
  });

  const deployResult = await rayfinItemClient.deployStaticContent(
    deployment.fabricWorkspaceId,
    deployment.fabricItemId,
    zipData
  );
  logStatic(
    `Deployed: ${validation.fileCount} files, ${formatBytes(validation.totalSizeBytes)}`
  );

  // ── Persist ───────────────────────────────────────────────────────
  if (deployResult.hostingUrl) {
    // Add the bare origin so Fabric/Power BI embedded postMessage handoff works.
    // Only update redirect URIs when auth is enabled — the backend rejects
    // runtime settings when auth is disabled.
    const baseOrigin = new URL(deployResult.hostingUrl).origin;
    const updatedServices = rayfinConfig.services.auth?.enabled
      ? addAllowedRedirectUri(rayfinConfig.services, baseOrigin)
      : rayfinConfig.services;

    if (updatedServices !== rayfinConfig.services) {
      try {
        await rayfinItemClient.updateHostingRedirectSettings(
          deployment.fabricWorkspaceId,
          deployment.fabricItemId,
          updatedServices
        );
        logStatic('Hosting URL added to allowed redirect URIs');
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        ext.outputChannel.appendLine(
          `Warning: Failed to update redirect URIs: ${errorMessage}`
        );
      }

      await updateRayfinConfig({ services: updatedServices }, projectRootUri);
    }

    // Rewrite deployment record with hosting URL
    let wsName = deployedWorkspaceName;
    if (!wsName) {
      const workspaceClient = new WorkspaceClient(
        session.accessToken,
        false,
        fabricSettings
      );
      const ws = await workspaceClient.getWorkspace(
        deployment.fabricWorkspaceId
      );
      wsName = ws.displayName;
    }
    await writeDeploymentEnvFile(projectRootUri, wsName, {
      fabricItemId: deployment.fabricItemId,
      rayfinApiUrl: deployment.fabricApiUrl,
      fabricWorkspaceId: deployment.fabricWorkspaceId,
      fabricTenantId: extractTenantIdFromToken(session.accessToken),
      publishableKey: deployment.publishableKey || undefined,
      fabricPortalUrl: fabricSettings.fabricPortalUrl,
      hostingUrl: deployResult.hostingUrl,
    });

    ext.outputChannel.appendLine(
      `Static content deployed — Hosting URL: ${deployResult.hostingUrl}`
    );

    const openApp = vscode.l10n.t('Open App');
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t('Static content deployed — {0}', deployResult.hostingUrl),
        openApp
      )
      .then((result) => {
        if (result === openApp) {
          void vscode.env.openExternal(
            vscode.Uri.parse(deployResult.hostingUrl!)
          );
        }
      });
  } else {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Static content deployed successfully.')
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}
