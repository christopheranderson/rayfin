/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DeployedCodeOrigin } from '@microsoft/rayfin-tools-common/_internal';
import {
  generateProjectSlug,
  isValidProjectName,
  visibleTemplates,
} from '@microsoft/rayfin-tools-common/_internal/templates/universal';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';
import { TemplateService } from '../services/TemplateService';
import { getFabricSession } from '../services/auth';
import { getFabricSettings } from '../services/fabric/constants';
import { RayfinItemClient } from '../services/fabric/rayfinItem';
import { WorkspaceClient } from '../services/fabric/workspace';
import { updateRayfinConfig } from '../services/rayfin/config';
import { writeDeploymentEnvFile } from '../services/rayfin/envFabric';
import { setPendingUriDeploy } from '../utils/autoOpenState';
import { classifyFolder } from '../utils/classifyFolder';
import { fileExists, readTextFile, writeTextFile } from '../utils/fs';
import { askOpenFolderChoice, executeOpenFolder } from '../utils/openFolder';
import { getDefaultProjectParentUri } from '../utils/projectLocation';

interface TemplateQuickPickItem extends vscode.QuickPickItem {
  templateName: string;
}

export interface CreateProjectOptions {
  /** Pre-filled project name (skips the name prompt if provided). */
  name?: string;
  /** Template name to auto-select (skips the template picker if provided). */
  templateName?: string;
  /** Fabric item ID from the Fabric portal. */
  fabricItemId?: string;
  /** Fabric workspace ID where the item lives. */
  fabricWorkspaceId?: string;
  /** Pre-selected project folder (skips the location picker if provided). */
  targetFolder?: string;
  /** Fabric REST API base URL from the portal (e.g. `https://api.fabric.microsoft.com`). */
  fabricApiUrl?: string;
  /** Fabric portal URL from the portal (e.g. `https://fabric.microsoft.com/`). */
  fabricPortalUrl?: string;
  /** Fabric environment name from the portal (e.g. "PROD"). */
  fabricEnvironment?: string;
  /**
   * Origin of code already deployed on the Fabric artifact.  When `None`
   * or `undefined` the extension auto-deploys after project creation;
   * any other value skips auto-deploy to avoid overwriting existing
   * backend code.
   */
  deployedCodeOrigin?: DeployedCodeOrigin;
}

/**
 * Command handler for "Project Rayfin: Create New Project".
 *
 * Flow: template quick pick → project name → location picker →
 *       open choice → scaffold → open project.
 *
 * Accepts an optional {@link CreateProjectOptions} so callers can invoke the
 * command programmatically with a pre-filled name:
 * ```ts
 * vscode.commands.executeCommand('rayfin.createProject', { name: 'my-app' });
 * ```
 */
export async function createProject(
  options?: CreateProjectOptions
): Promise<void> {
  // 1. Pick a template
  const templateService = new TemplateService();
  const templates = await templateService.listBundledTemplates();

  if (templates.length === 0) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('No project templates are available.')
    );
    return;
  }

  let pickedTemplateName: string;

  if (options?.templateName) {
    // Auto-select template when specified (e.g. from Getting Started view)
    const autoTemplate = templates.find(
      (t) => t.name === options?.templateName
    );
    if (!autoTemplate) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Template "{0}" is not available.', options.templateName)
      );
      return;
    }
    pickedTemplateName = autoTemplate.name;
  } else {
    const browsable = visibleTemplates(templates);

    if (browsable.length === 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('No project templates are available.')
      );
      return;
    }

    const items: TemplateQuickPickItem[] = browsable.map((t) => ({
      label: t.displayName,
      detail: t.description,
      templateName: t.name,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t('Select a project template'),
      title: vscode.l10n.t('Project Template'),
      matchOnDetail: true,
    });

    if (!picked) {
      return;
    }
    pickedTemplateName = picked.templateName;
  }

  // 2. Project name (prompt unless passed in)
  const projectName = options?.name ?? (await promptProjectName());

  if (!projectName) {
    return;
  }

  const slug = generateProjectSlug(projectName);

  // 3. Select location for the project
  const parentUri = options?.targetFolder
    ? vscode.Uri.file(options.targetFolder)
    : await pickProjectLocation(slug);

  if (!parentUri) {
    return;
  }

  const targetUri = vscode.Uri.joinPath(parentUri, slug);

  // 4. Classify the target folder — abort if it already has content.
  const classification = await classifyFolder(targetUri);
  if (classification.kind !== 'empty') {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'The selected folder is not empty. Please choose an empty location.'
      )
    );
    return;
  }

  // 5. Ask how to open the project BEFORE any I/O — cancelling here
  //    means no files are written to disk.
  const openChoice = await askOpenFolderChoice(targetUri);

  if (!openChoice) {
    return;
  }

  // 6. Scaffold the project
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Creating project "{0}"…', projectName),
      cancellable: false,
    },
    async () => {
      await templateService.scaffoldProject(
        pickedTemplateName,
        targetUri,
        projectName
      );
    }
  );

  // 7. Pre-seed project name into rayfin.yml (overrides template defaults)
  await updateRayfinConfig({ id: slug, name: projectName }, targetUri);

  // 8. Pre-seed deployment info if provided (e.g. from URI handler)
  if (options?.fabricItemId || options?.fabricWorkspaceId) {
    await seedDeploymentInfo(targetUri, options);
    // Only auto-deploy when no code has been deployed yet. If the portal
    // already deployed a template or user code, skip auto-deploy so we
    // don't overwrite the backend.
    const origin = options.deployedCodeOrigin;
    if (!origin || origin === 'None') {
      await setPendingUriDeploy(ext.context, slug, options.fabricWorkspaceId);
    }
  }

  // 8b. Seed Fabric environment URLs for non-production environments.
  // Production uses the defaults baked into getFabricSettings(), so no
  // override is needed.
  if (
    (options?.fabricApiUrl || options?.fabricPortalUrl) &&
    options?.fabricEnvironment?.toUpperCase() !== 'PROD'
  ) {
    // TEMPORARY WORKAROUND: The portal sends apiURL as the shared
    // endpoint, not the Public API. Override with the correct
    // Fabric API host until the portal sends the right value.
    // Remove once the fix (5.3 train) is deployed to MSIT.
    const envApiOverrides: Record<string, string> = {
      DAILY: 'https://dailyapi.fabric.microsoft.com',
      DXT: 'https://dxtapi.fabric.microsoft.com',
      MSIT: 'https://msitapi.fabric.microsoft.com',
    };
    const envKey = options.fabricEnvironment?.toUpperCase() ?? '';
    if (envApiOverrides[envKey]) {
      options = { ...options, fabricApiUrl: envApiOverrides[envKey] };
    }

    await seedFabricInfo(targetUri, options);
  }

  // 8b. Seed Fabric environment URLs for non-production environments.
  // Production uses the defaults baked into getFabricSettings(), so no
  // override is needed.
  if (
    (options?.fabricApiUrl || options?.fabricPortalUrl) &&
    options?.fabricEnvironment?.toUpperCase() !== 'PROD'
  ) {
    // TEMPORARY WORKAROUND: The portal sends apiURL as the shared
    // endpoint, not the Public API. Override with the correct
    // Fabric API host until the portal sends the right value.
    // Remove once the fix (5.3 train) is deployed to MSIT.
    const envApiOverrides: Record<string, string> = {
      DAILY: 'https://dailyapi.fabric.microsoft.com',
      DXT: 'https://dxtapi.fabric.microsoft.com',
      MSIT: 'https://msitapi.fabric.microsoft.com',
    };
    const envKey = options.fabricEnvironment?.toUpperCase() ?? '';
    if (envApiOverrides[envKey]) {
      options = { ...options, fabricApiUrl: envApiOverrides[envKey] };
    }

    await seedFabricInfo(targetUri, options);
  }

  // 9. Open the scaffolded project using the pre-captured choice
  await executeOpenFolder(targetUri, projectName, openChoice);
}

/**
 * Seed Fabric environment URLs into `rayfin/.env` so that
 * `getFabricSettings()` resolves the correct environment without
 * hardcoding internal hostnames in the open-source repo.
 */
async function seedFabricInfo(
  projectUri: vscode.Uri,
  options: CreateProjectOptions
): Promise<void> {
  const envUri = vscode.Uri.joinPath(projectUri, 'rayfin', '.env');
  try {
    let existing = '';
    if (await fileExists(envUri)) {
      existing = await readTextFile(envUri);
    }

    const lines: string[] = [];
    if (options.fabricApiUrl) {
      lines.push(`RAYFIN_FABRIC_API_URL=${options.fabricApiUrl}`);
    }
    if (options.fabricPortalUrl) {
      lines.push(`RAYFIN_FABRIC_PORTAL_URL=${options.fabricPortalUrl}`);
    }

    if (lines.length === 0) return;

    // Replace existing values or append new ones
    let content = existing;
    for (const line of lines) {
      const key = line.slice(0, line.indexOf('='));
      const pattern = new RegExp(`^${key}=.*$`, 'm');
      if (pattern.test(content)) {
        content = content.replace(pattern, line);
      } else {
        content =
          content.trimEnd() +
          (content.length > 0 ? '\n' : '') +
          '\n# Fabric environment (set by "Open in VS Code")\n' +
          line +
          '\n';
      }
    }

    await writeTextFile(envUri, content);
    ext.outputChannel.appendLine(
      'Seeded rayfin/.env with Fabric environment URLs from URI payload'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    ext.outputChannel.appendLine(
      `Warning: Could not seed Fabric environment info: ${errorMessage}`
    );
  }
}

/**
 * Pre-seed deployment metadata in the registry from URI handler payload
 * so the first "Rayfin: Deploy to Fabric" reuses the existing item without prompting.
 *
 * When `deployedCodeOrigin` is `'Template'`, the backend has already been
 * deployed from the portal.  In that case we fetch the full deployment
 * values (BaaS endpoint, publishable key, portal URL) so the project
 * view shows the correct "Deployed" status without requiring another
 * "Rayfin: Deploy to Fabric".
 */
async function seedDeploymentInfo(
  projectUri: vscode.Uri,
  options: CreateProjectOptions
): Promise<void> {
  try {
    // Resolve workspace display name for the deployment registry key
    let workspaceName: string | undefined;
    const session = await getFabricSession({ createIfNone: false });
    const fabricSettings = getFabricSettings();

    if (options.fabricWorkspaceId && session) {
      try {
        const client = new WorkspaceClient(
          session.accessToken,
          false,
          fabricSettings
        );
        const workspace = await client.getWorkspace(options.fabricWorkspaceId);
        workspaceName = workspace.displayName;
      } catch {
        // Non-fatal — fall back to writing only the registry seed
      }
    }

    // When the portal already deployed code (template or user), retrieve
    // the full deployment values so the deployment registry reflects a real
    // deployment and the project view shows "Deployed".
    if (
      (options.deployedCodeOrigin === 'Template' ||
        options.deployedCodeOrigin === 'User') &&
      session &&
      options.fabricWorkspaceId &&
      options.fabricItemId
    ) {
      try {
        const rayfinItemClient = new RayfinItemClient(
          session.accessToken,
          false,
          fabricSettings
        );

        const extendedProps = await rayfinItemClient.getExtendedProperties(
          options.fabricWorkspaceId,
          options.fabricItemId
        );

        let publishableKey: string | undefined;
        try {
          publishableKey = await rayfinItemClient.retrievePublishableKey(
            options.fabricWorkspaceId,
            options.fabricItemId
          );
        } catch {
          // Non-fatal — deployment will still be recognised if endpoint is
          // present, but the key can be fetched on next deploy.
        }

        const vars = {
          fabricItemId: options.fabricItemId,
          rayfinApiUrl: extendedProps.BaaSEndpoint,
          fabricWorkspaceId: options.fabricWorkspaceId,
          publishableKey: publishableKey || undefined,
          fabricPortalUrl: fabricSettings.fabricPortalUrl,
        };

        await writeDeploymentEnvFile(
          projectUri,
          workspaceName ?? 'default',
          vars
        );

        ext.outputChannel.appendLine(
          `Pre-seeded deployment registry with full deployment info (origin: ${options.deployedCodeOrigin})`
        );
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ext.outputChannel.appendLine(
          `Warning: Could not retrieve deployment info for ${options.deployedCodeOrigin} origin, falling back to basic seed: ${msg}`
        );
        // Fall through to basic seed below
      }
    }

    // Default: seed only the item ID and workspace ID — the API URL,
    // publishable key, and other fields are computed during deployment.
    const vars = {
      fabricItemId: options.fabricItemId,
      fabricWorkspaceId: options.fabricWorkspaceId,
    };

    await writeDeploymentEnvFile(projectUri, workspaceName ?? 'default', vars);

    ext.outputChannel.appendLine(
      'Pre-seeded deployment registry with info from URI payload'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    ext.outputChannel.appendLine(
      `Warning: Could not pre-seed deployment info: ${errorMessage}`
    );
  }
}

async function promptProjectName(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: vscode.l10n.t('Enter a project name'),
    placeHolder: 'My Rayfin App',
    validateInput: (value) => {
      if (!value.trim()) {
        return vscode.l10n.t('Project name is required');
      }
      if (!isValidProjectName(value)) {
        return vscode.l10n.t(
          'Use only letters, numbers, spaces, hyphens, or underscores'
        );
      }
      return undefined;
    },
  });
}

/**
 * Offer a location for the new project.
 *
 * - If the current workspace folder is empty, offer it directly.
 * - Otherwise, default to `~/RayfinApps/<slug>`.
 * - Always allow browsing for another directory.
 */
async function pickProjectLocation(
  slug: string
): Promise<vscode.Uri | undefined> {
  const currentFolder = vscode.workspace.workspaceFolders?.[0];
  const rayfinAppsUri = getDefaultProjectParentUri();
  const defaultPath = rayfinAppsUri
    ? vscode.Uri.joinPath(rayfinAppsUri, slug).fsPath
    : undefined;

  // Check if current workspace folder is empty
  let currentFolderIsEmpty = false;
  if (currentFolder) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        currentFolder.uri
      );
      currentFolderIsEmpty = entries.length === 0;
    } catch {
      // Can't read → treat as non-empty
    }
  }

  const items: vscode.QuickPickItem[] = [];

  if (currentFolderIsEmpty && currentFolder) {
    items.push({
      label: vscode.l10n.t('Current directory'),
      description: currentFolder.uri.fsPath,
    });
  }

  if (defaultPath) {
    items.push({
      label: vscode.l10n.t('Default directory'),
      description: defaultPath,
    });
  }

  items.push({
    label: `$(folder-opened) ${vscode.l10n.t('Choose another directory…')}`,
  });

  const choice = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Project location'),
    placeHolder: vscode.l10n.t('Where should the project live?'),
  });

  if (!choice) {
    return undefined;
  }

  // Current directory (only shown when empty)
  if (
    currentFolderIsEmpty &&
    currentFolder &&
    choice.description === currentFolder.uri.fsPath
  ) {
    return currentFolder.uri;
  }

  // Default ~/RayfinApps
  if (defaultPath && choice.description === defaultPath) {
    return rayfinAppsUri;
  }

  // Browse
  const folderSelection = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: vscode.l10n.t('Select Folder'),
  });

  if (!folderSelection || folderSelection.length === 0) {
    return undefined;
  }

  return folderSelection[0];
}
