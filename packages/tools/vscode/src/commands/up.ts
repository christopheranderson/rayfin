/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  addAllowedRedirectUri,
  composeFabricItemDeepLink,
  validateFunctionsConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';
import { getFabricSession } from '../services/auth';
import { getFabricSettings } from '../services/fabric/constants';
import type { FabricSettings } from '../services/fabric/constants';
import { RayfinItemClient } from '../services/fabric/rayfinItem';
import {
  WorkspaceClient,
  type FabricWorkspace,
} from '../services/fabric/workspace';
import {
  loadRayfinConfig,
  loadEnvironmentVariables,
  updateRayfinConfig,
} from '../services/rayfin/config';
import {
  extractTenantIdFromToken,
  readLatestDeployment,
  resolveDeploymentFromEnvFiles,
  warnAboutLegacyMigrations,
  writeDeploymentEnvFile,
} from '../services/rayfin/envFabric';
import { findRayfinProjectRoot } from '../services/rayfin/projectUtils';
import { type RayfinConfig } from '../services/rayfin/types';
import {
  formatBytes,
  logStatic,
  packageStaticFolder,
  validateStaticFolder,
} from '../services/static/staticHosting';
import { fileExists } from '../utils/fs';
import { runStaticBuild } from '../utils/staticBuild';

import { assertStaticHostingAccessSupported } from './staticHostingAccess';

/**
 * Deploy the application to Fabric as a Rayfin item.
 *
 * This is the VS Code port of the CLI `rayfin up` command.
 * Phases:
 *   1   — Load project config
 *   1.5 — Generate Rayfin Data config (shell to CLI)
 *   2   — Authenticate
 *   3   — Resolve workspace
 *   4   — Create/reuse Rayfin item
 *   5   — Resolve workload endpoint
 *   6a  — POST runtime settings
 *   6b  — Apply Rayfin Data config
 *   7   — Persist metadata to .deployments.json + rayfin/.env
 *   8   — Deploy static content (build → validate → package → deploy)
 */
export interface UpOptions {
  /** When provided, the workspace with this display name is used without prompting. */
  workspaceName?: string;
  /** When provided (e.g. from the portal "Open in VS Code" flow), the workspace
   *  with this ID is used directly, bypassing deployment registry resolution. */
  fabricWorkspaceId?: string;
  /** External cancellation token (e.g. from an LM tool invocation). */
  cancellationToken?: vscode.CancellationToken;
}

export interface UpResult {
  /** Deep link to the deployed item in the Fabric portal. */
  fabricDeepLink: string;
}

export async function up(options?: UpOptions): Promise<UpResult> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Up: Deploy to Fabric'),
      cancellable: true,
    },
    async (progress, progressToken) => {
      // Merge the progress-dialog token with an optional external token
      // so that cancellation from either source is respected.
      const cts = new vscode.CancellationTokenSource();
      const externalSub = options?.cancellationToken?.onCancellationRequested(
        () => cts.cancel()
      );
      const progressSub = progressToken.onCancellationRequested(() =>
        cts.cancel()
      );
      const token = cts.token;

      try {
        return await runDeployment(progress, token, options);
      } catch (error) {
        if (token.isCancellationRequested) {
          void vscode.window.showWarningMessage(vscode.l10n.t('Up cancelled.'));
          throw error;
        }
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        ext.outputChannel.appendLine(`Up failed: ${errorMessage}`);
        if (error instanceof Error && error.stack) {
          ext.outputChannel.appendLine(error.stack);
        }
        ext.outputChannel.show(true);
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Up failed: {0}', errorMessage)
        );
        throw error;
      } finally {
        externalSub?.dispose();
        progressSub.dispose();
        cts.dispose();
      }
    }
  );
}

async function runDeployment(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  options?: UpOptions
): Promise<UpResult> {
  // ── Phase 1 — Load project config ─────────────────────────────────
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
  validateRayfinConfigForUp(rayfinConfig);
  assertStaticHostingAccessSupported(rayfinConfig);

  // Resolve Fabric settings from project .env overrides
  const envVars = await loadEnvironmentVariables({
    projectRoot: projectRootUri,
  });
  const functionsErrors = validateFunctionsConfig(
    rayfinConfig.services.functions
  );
  if (functionsErrors.length > 0) {
    throw new Error(functionsErrors.map(({ message }) => message).join('\n'));
  }

  // Read existing deployment metadata from the registry
  const existingDeployment = await readLatestDeployment(projectRootUri);

  // Surface env-strategy v1 → v2 migration guidance on first run.
  await warnAboutLegacyMigrations(projectRootUri);

  const fabricSettings: FabricSettings = getFabricSettings(
    Object.fromEntries(envVars)
  );

  const projectName = rayfinConfig.name;
  ext.outputChannel.appendLine(
    `Using project name '${projectName}' from rayfin.yml`
  );

  throwIfCancelled(token);

  // ── Phase 1.5 — Generate Rayfin Data config (shell to CLI) ────────
  let dataConfigUri: vscode.Uri | undefined;
  if (rayfinConfig.services.data.enabled) {
    progress.report({
      message: vscode.l10n.t('Generating database configuration...'),
    });

    dataConfigUri = await generateDataConfig(projectRootUri);
    ext.outputChannel.appendLine(
      `Rayfin Data config ready: ${dataConfigUri.toString(true)}`
    );

    throwIfCancelled(token);
  }

  // ── Phase 2 — Authenticate ────────────────────────────────────────
  progress.report({ message: vscode.l10n.t('Authenticating with Fabric...') });

  const session = await getFabricSession({
    createIfNone: true,
  });

  if (!session) {
    throw new Error('Authentication was cancelled.');
  }

  const accessToken = session.accessToken;
  ext.outputChannel.appendLine(`Authenticated as ${session.account.label}`);

  throwIfCancelled(token);

  // ── Phase 3 — Resolve workspace ───────────────────────────────────
  progress.report({ message: vscode.l10n.t('Resolving Fabric workspace...') });

  const workspaceClient = new WorkspaceClient(
    accessToken,
    false,
    fabricSettings
  );
  const { workspaceId, displayName } = await resolveWorkspace(
    workspaceClient,
    projectRootUri,
    options?.workspaceName,
    options?.fabricWorkspaceId
  );

  ext.outputChannel.appendLine(`Using workspace ${workspaceId}`);

  throwIfCancelled(token);

  // ── Phase 4 — Create/reuse Rayfin item ────────────────────────────
  progress.report({ message: vscode.l10n.t('Preparing Rayfin item...') });

  const rayfinItemClient = new RayfinItemClient(
    accessToken,
    false,
    fabricSettings
  );
  const fabricItemId = await resolveRayfinItem(
    rayfinItemClient,
    workspaceId,
    projectName,
    existingDeployment?.deployment
  );

  ext.outputChannel.appendLine(`Fabric item ready (ID: ${fabricItemId})`);

  throwIfCancelled(token);

  // ── Phase 5 — Resolve workload endpoint ───────────────────────────
  progress.report({ message: vscode.l10n.t('Resolving workload endpoint...') });

  const extendedProps = await rayfinItemClient.getExtendedProperties(
    workspaceId,
    fabricItemId
  );
  const baasEndpoint = extendedProps.BaaSEndpoint;

  const itemEndpoint = rayfinItemClient.getRayfinItemEndpoint(
    workspaceId,
    fabricItemId
  );
  ext.outputChannel.appendLine(`Workload endpoint: ${baasEndpoint}`);

  throwIfCancelled(token);

  // ── Retrieve publishable key ──────────────────────────────────────
  let publishableKey = '';
  try {
    publishableKey = await rayfinItemClient.retrievePublishableKey(
      workspaceId,
      fabricItemId
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    ext.outputChannel.appendLine(
      `Warning: Could not retrieve publishable key: ${errorMessage}`
    );
  }

  throwIfCancelled(token);

  // ── Phase 6a — POST runtime settings ──────────────────────────────
  progress.report({ message: vscode.l10n.t('Applying runtime settings...') });

  await rayfinItemClient.applyRuntimeSettings(
    workspaceId,
    fabricItemId,
    rayfinConfig.services
  );
  ext.outputChannel.appendLine('Runtime settings applied');

  throwIfCancelled(token);

  // ── Phase 6b — Apply Rayfin Data config ──────────────────────────────
  if (rayfinConfig.services.data.enabled && dataConfigUri) {
    progress.report({
      message: vscode.l10n.t('Applying database configuration...'),
    });

    await rayfinItemClient.applyDataConfigWithRetry(
      dataConfigUri,
      workspaceId,
      fabricItemId
    );
  }

  throwIfCancelled(token);

  // ── Phase 7 — Persist metadata to .deployments.json + rayfin/.env ──
  progress.report({
    message: vscode.l10n.t('Persisting deployment metadata...'),
  });

  const fabricTenantId = extractTenantIdFromToken(accessToken);
  // Deep link to the deployed Rayfin item. Including the tenant `ctid`
  // ensures the auth popup targets the correct authority for cross-tenant
  // workspaces (previously the link was tenant-less and would fail those).
  const fabricDeepLink = composeFabricItemDeepLink(
    fabricSettings.fabricPortalUrl,
    workspaceId,
    fabricItemId,
    fabricTenantId ?? undefined
  );

  // Write deployment record to rayfin/.deployments.json + mirror into rayfin/.env
  await writeDeploymentEnvFile(projectRootUri, displayName, {
    fabricItemId,
    rayfinApiUrl: baasEndpoint,
    fabricWorkspaceId: workspaceId,
    fabricTenantId,
    publishableKey: publishableKey || undefined,
    fabricPortalUrl: fabricSettings.fabricPortalUrl,
  });

  ext.outputChannel.appendLine(
    `Updated rayfin/.deployments.json and rayfin/.env`
  );
  ext.outputChannel.appendLine(`  Fabric Item ID: ${fabricItemId}`);
  ext.outputChannel.appendLine(`  Endpoint: ${itemEndpoint}`);
  ext.outputChannel.appendLine(`  Fabric Workspace: ${workspaceId}`);
  ext.outputChannel.appendLine(`  Portal: ${fabricDeepLink}`);
  if (publishableKey) {
    ext.outputChannel.appendLine(
      `  Publishable Key: ${publishableKey.slice(0, 8)}...`
    );
  }

  throwIfCancelled(token);

  // ── Phase 8 — Deploy static content ───────────────────────────────
  let staticHostingUrl: string | undefined;
  const staticConfig = rayfinConfig.services.staticHosting;
  if (staticConfig?.enabled) {
    // 8a — Run build command via Task API
    if (staticConfig.buildCommand) {
      progress.report({
        message: vscode.l10n.t('Building static content...'),
      });

      const buildCwd = vscode.Uri.joinPath(
        projectRootUri,
        staticConfig.root || '.'
      );
      const exitCode = await runStaticBuild(
        staticConfig.buildCommand,
        buildCwd
      );
      if (exitCode !== 0) {
        throw new Error(
          'Static build command failed. Check the terminal output for details.'
        );
      }
      logStatic('Build command completed');
    }

    throwIfCancelled(token);

    // 8b — Validate static folder
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

    // 8c — Package to ZIP
    progress.report({
      message: vscode.l10n.t('Packaging static content...'),
    });

    const zipData = await packageStaticFolder(validation.resolvedUri);
    logStatic(`Packaged: ${formatBytes(zipData.byteLength)} compressed`);

    throwIfCancelled(token);

    // 8d — Deploy ZIP
    progress.report({
      message: vscode.l10n.t('Deploying static content...'),
    });

    const deployResult = await rayfinItemClient.deployStaticContent(
      workspaceId,
      fabricItemId,
      zipData
    );
    logStatic(
      `Deployed: ${validation.fileCount} files, ${formatBytes(validation.totalSizeBytes)}`
    );

    if (deployResult.hostingUrl) {
      staticHostingUrl = deployResult.hostingUrl;
      ext.outputChannel.appendLine(`  Hosting URL: ${deployResult.hostingUrl}`);
    }
    if (deployResult.deploymentId) {
      ext.outputChannel.appendLine(
        `  Deployment ID: ${deployResult.deploymentId}`
      );
    }

    throwIfCancelled(token);

    // 8e — Update allowedRedirectUris with hosting URL
    // Only update redirect URIs when auth is enabled — the backend rejects
    // runtime settings when auth is disabled.
    if (staticHostingUrl) {
      progress.report({
        message: vscode.l10n.t('Updating redirect URIs...'),
      });

      const baseOrigin = new URL(staticHostingUrl).origin;
      const updatedServices = rayfinConfig.services.auth?.enabled
        ? addAllowedRedirectUri(rayfinConfig.services, baseOrigin)
        : rayfinConfig.services;

      if (updatedServices !== rayfinConfig.services) {
        try {
          await rayfinItemClient.applyRuntimeSettings(
            workspaceId,
            fabricItemId,
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

        // Persist updated services (with redirect URI) to rayfin.yml
        await updateRayfinConfig({ services: updatedServices }, projectRootUri);
      }
    }

    // Rewrite deployment record with hostingUrl
    if (staticHostingUrl) {
      await writeDeploymentEnvFile(projectRootUri, displayName, {
        fabricItemId,
        rayfinApiUrl: baasEndpoint,
        fabricWorkspaceId: workspaceId,
        fabricTenantId,
        publishableKey: publishableKey || undefined,
        fabricPortalUrl: fabricSettings.fabricPortalUrl,
        hostingUrl: staticHostingUrl,
      });
    }
  }

  // ── Success ───────────────────────────────────────────────────────
  const openInFabric = vscode.l10n.t('Open in Fabric');
  const openApp = vscode.l10n.t('Open App');
  const actions = staticHostingUrl ? [openApp, openInFabric] : [openInFabric];

  void vscode.window
    .showInformationMessage(
      staticHostingUrl
        ? vscode.l10n.t(
            'Project "{0}" deployed to Fabric — app live at {1}',
            projectName,
            staticHostingUrl
          )
        : vscode.l10n.t('Project "{0}" deployed to Fabric', projectName),
      ...actions
    )
    .then((result) => {
      if (result === openInFabric) {
        void vscode.env.openExternal(vscode.Uri.parse(fabricDeepLink));
      } else if (result === openApp && staticHostingUrl) {
        void vscode.env.openExternal(vscode.Uri.parse(staticHostingUrl));
      }
    });

  return { fabricDeepLink };
}

// ── Helper Functions ──────────────────────────────────────────────────

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

function throwIfInsufficientPrivileges(
  error: unknown,
  workspaceId: string
): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('403') || message.includes('InsufficientPrivileges')) {
    throw new Error(
      `You do not have access to Fabric workspace ${workspaceId}. ` +
        'Ask the workspace owner to grant you permissions, or choose a different workspace.'
    );
  }
}

function validateRayfinConfigForUp(
  rayfinConfig: RayfinConfig | null
): asserts rayfinConfig is RayfinConfig {
  if (!rayfinConfig || typeof rayfinConfig !== 'object') {
    throw new Error(
      'Could not load rayfin.yml configuration. Ensure your project contains rayfin/rayfin.yml.'
    );
  }

  if (typeof rayfinConfig.id !== 'string' || !rayfinConfig.id.trim()) {
    throw new Error(
      "Project name not found in rayfin.yml configuration. Ensure you have a rayfin.yml file with a project 'id' field. Run 'rayfin init' to create a new project configuration."
    );
  }

  if (!rayfinConfig.services || typeof rayfinConfig.services !== 'object') {
    throw new Error("Invalid rayfin.yml: missing required 'services' section.");
  }

  if (
    !rayfinConfig.services.data ||
    typeof rayfinConfig.services.data !== 'object'
  ) {
    throw new Error(
      "Invalid rayfin.yml: missing required 'services.data' section."
    );
  }

  if (typeof rayfinConfig.services.data.enabled !== 'boolean') {
    throw new Error(
      "Invalid rayfin.yml: 'services.data.enabled' must be a boolean."
    );
  }
}

/**
 * Generate the Rayfin Data config file by running the Rayfin CLI via VS Code Task API.
 *
 * Uses `vscode.tasks.executeTask` with a `ShellExecution` to invoke the local
 * Rayfin CLI in desktop/dev-container environments. The config is always
 * regenerated to avoid stale configs.
 */
async function generateDataConfig(
  projectRootUri: vscode.Uri
): Promise<vscode.Uri> {
  const expectedOutputUri = vscode.Uri.joinPath(
    projectRootUri,
    'rayfin',
    '.temp',
    'dab-config.json'
  );

  ext.outputChannel.appendLine(
    'Generating Rayfin Data config via Rayfin CLI...'
  );

  const taskDefinition: vscode.TaskDefinition = { type: 'rayfin-dab-gen' };

  const execution = new vscode.ShellExecution(
    'npx',
    ['rayfin', 'dev', 'db', 'apply', '--gen-config-only'],
    {
      cwd: projectRootUri.fsPath,
    }
  );

  const task = new vscode.Task(
    taskDefinition,
    vscode.TaskScope.Workspace,
    'Generate Rayfin Data Config',
    'Rayfin',
    execution
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Silent,
    panel: vscode.TaskPanelKind.Shared,
    clear: true,
  };

  let exitCode: number;
  try {
    exitCode = await runTask(task);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Database configuration generation could not be started: ${errorMessage}`
    );
  }

  if (exitCode !== 0) {
    ext.outputChannel.appendLine(
      `Rayfin Data config generation failed with exit code ${exitCode}`
    );

    // Focus the task terminal so the user can inspect the command output
    const taskTerminal = vscode.window.terminals.find((t) =>
      t.name.includes('Generate Rayfin Data Config')
    );
    if (taskTerminal) {
      taskTerminal.show();
    }

    throw new Error(
      'Database configuration generation failed. Check the terminal output for details.'
    );
  }

  if (!(await fileExists(expectedOutputUri))) {
    throw new Error(
      `Rayfin Data configuration file was not generated at expected path: ${expectedOutputUri.toString(true)}`
    );
  }

  return expectedOutputUri;
}

/**
 * Execute a VS Code task and return its exit code.
 *
 * Returns a promise that resolves with the process exit code when the task
 * finishes, or rejects if the task could not be started.
 */
function runTask(task: vscode.Task): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task === task) {
        disposable.dispose();
        resolve(event.exitCode ?? 1);
      }
    });

    vscode.tasks.executeTask(task).then(undefined, (error: unknown) => {
      disposable.dispose();
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      reject(
        new Error(
          `Failed to start Rayfin Data config generation task: ${errorMessage}`
        )
      );
    });
  });
}

/**
 * Resolve the Fabric workspace to deploy into.
 * Shows a QuickPick if multiple workspaces are available.
 */
async function resolveWorkspace(
  workspaceClient: WorkspaceClient,
  projectRootUri: vscode.Uri,
  workspaceName?: string,
  fabricWorkspaceId?: string
): Promise<{ workspaceId: string; displayName: string }> {
  let workspace: FabricWorkspace | undefined;

  // If an explicit workspace ID was provided (e.g. portal "Open in VS Code"
  // flow), use it directly — ignore any stale deployment registry entries.
  if (fabricWorkspaceId) {
    ext.outputChannel.appendLine(
      `Using portal-provided workspace ID: ${fabricWorkspaceId}`
    );
    try {
      workspace = await workspaceClient.getWorkspace(fabricWorkspaceId);
    } catch (error) {
      throwIfInsufficientPrivileges(error, fabricWorkspaceId);
      throw new Error(
        `Fabric workspace from portal (${fabricWorkspaceId}) is not accessible.`
      );
    }
  }

  // If an explicit workspace name was provided, find it by display name
  if (!workspace && workspaceName) {
    const workspaces = await workspaceClient.listWorkspaces();
    const lowerName = workspaceName.toLowerCase();
    workspace = workspaces.find(
      (ws) => ws.displayName.toLowerCase() === lowerName
    );
    if (!workspace) {
      throw new Error(
        `Fabric workspace "${workspaceName}" not found. Available workspaces: ${workspaces.map((ws) => ws.displayName).join(', ')}`
      );
    }
  }

  // Check the deployment registry for an existing deployment
  if (!workspace) {
    const envResult = await resolveDeploymentFromEnvFiles(projectRootUri);
    const envWorkspaceId = envResult?.deployment.fabricWorkspaceId;
    if (envResult && envWorkspaceId) {
      ext.outputChannel.appendLine(
        `Found existing deployment for workspace "${envResult.workspaceName}"`
      );
      try {
        workspace = await workspaceClient.getWorkspace(envWorkspaceId);
      } catch (error) {
        throwIfInsufficientPrivileges(error, envWorkspaceId);
        ext.outputChannel.appendLine(
          `Workspace ${envWorkspaceId} from deployment registry not accessible, falling back...`
        );
      }
    }
  }

  // Fall back to the active deployment in the registry (e.g. pre-seeded
  // from "Open in VS Code" flow)
  if (!workspace) {
    const latestResult = await readLatestDeployment(projectRootUri);
    const latestWorkspaceId = latestResult?.deployment.fabricWorkspaceId;
    if (latestResult && latestWorkspaceId) {
      ext.outputChannel.appendLine(
        `Found pre-seeded deployment (workspace ID: ${latestWorkspaceId})`
      );
      try {
        workspace = await workspaceClient.getWorkspace(latestWorkspaceId);
      } catch (error) {
        throwIfInsufficientPrivileges(error, latestWorkspaceId);
        ext.outputChannel.appendLine(
          `Workspace ${latestWorkspaceId} from deployment registry not accessible, falling back...`
        );
      }
    }
  }

  if (!workspace) {
    const workspaces = await workspaceClient.listWorkspaces();

    if (workspaces.length === 0) {
      throw new Error(
        'No Fabric workspaces found. Create a workspace in the Fabric portal first.'
      );
    }

    if (workspaces.length === 1) {
      workspace = workspaces[0];
    } else {
      const items = workspaces.map((ws) => ({
        label: ws.displayName,
        description: ws.id,
        workspace: ws,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select a Fabric workspace to deploy into'),
        title: vscode.l10n.t('Fabric Workspace'),
      });

      if (!selected) {
        throw new Error('Up cancelled — no workspace selected.');
      }

      workspace = selected.workspace;
    }
  }

  if (!workspace) {
    throw new Error('Could not resolve a Fabric workspace.');
  }

  ext.outputChannel.appendLine(
    `Using workspace "${workspace.displayName}" (ID: ${workspace.id})`
  );

  return {
    workspaceId: workspace.id,
    displayName: workspace.displayName,
  };
}

/**
 * Resolve the Rayfin item ID — reuse existing or create new.
 */
async function resolveRayfinItem(
  rayfinItemClient: RayfinItemClient,
  workspaceId: string,
  projectName: string,
  existingDeployment?: import('@microsoft/rayfin-tools-common/_internal/config').DeploymentInfo
): Promise<string> {
  const existingItemId = existingDeployment?.fabricItemId;
  const existingWorkspaceId = existingDeployment?.fabricWorkspaceId;

  // Detect workspace change
  const workspaceChanged =
    existingItemId &&
    existingWorkspaceId &&
    existingWorkspaceId !== workspaceId;

  if (workspaceChanged) {
    ext.outputChannel.appendLine(
      `Workspace changed from ${existingWorkspaceId} to ${workspaceId} — creating a new Rayfin item`
    );
  }

  if (existingItemId && !workspaceChanged) {
    ext.outputChannel.appendLine(
      `Redeployment detected — reusing Rayfin item ${existingItemId}`
    );
    return existingItemId;
  }

  const item = await rayfinItemClient.getOrCreateRayfinItem(
    workspaceId,
    projectName
  );
  return item.id;
}
