/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseRayfinYaml } from '@microsoft/rayfin-tools-common/_internal/config';
import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';

import { RayfinUriHandler, type UriPayload } from './commands/RayfinUriHandler';
import { createProject } from './commands/createProject';
import { signIn } from './commands/signIn';
import { up, type UpOptions } from './commands/up';
import { upStaticDeploy } from './commands/upStaticDeploy';
import { UP_TOOL_NAME, UpTool } from './commands/upTool';
import { ext } from './extensionVariables';
import { VSCodeCommandRunner } from './services/CommandRunner';
import { getEnvironmentInfo } from './telemetry/env';
import { registerTrackedCommand } from './telemetry/registerTrackedCommand';
import { TelemetryReporter } from './telemetry/reporter';
import {
  hasPendingUriDeploy,
  isAutoOpenDismissed,
} from './utils/autoOpenState';
import { fileExists, readTextFile } from './utils/fs';
import { GettingStartedViewController } from './webviews/gettingStartedView/gettingStartedViewController';
import { ProjectViewController } from './webviews/projectView/projectViewController';

/**
 * Register the bundled Rayfin Copilot plugin by appending
 * its path to the `chat.pluginLocations` VS Code setting.
 */
function registerCopilotPlugin(context: vscode.ExtensionContext): void {
  const pluginUri = vscode.Uri.joinPath(context.extensionUri, 'rayfin');
  const pluginPath = pluginUri.fsPath;

  const outputChannel =
    ext.outputChannel ?? vscode.window.createOutputChannel('Project Rayfin');
  outputChannel.appendLine(
    `[Plugin] Registering Copilot plugin at: ${pluginPath}`
  );

  const config = vscode.workspace.getConfiguration('chat');
  const raw = config.get<Record<string, boolean>>('pluginLocations');
  const locations: Record<string, boolean> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};

  outputChannel.appendLine(
    `[Plugin] Current chat.pluginLocations: ${JSON.stringify(locations)}`
  );

  if (!locations[pluginPath]) {
    locations[pluginPath] = true;
    config
      .update('pluginLocations', locations, vscode.ConfigurationTarget.Global)
      .then(
        () =>
          outputChannel.appendLine(
            '[Plugin] Successfully updated chat.pluginLocations'
          ),
        (err) =>
          outputChannel.appendLine(
            `[Plugin] Failed to update chat.pluginLocations: ${err}`
          )
      );
  } else {
    outputChannel.appendLine('[Plugin] Plugin path already registered');
  }
}

async function findRayfinWorkspaceFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const folder of folders) {
    const configUri = vscode.Uri.joinPath(folder.uri, 'rayfin', 'rayfin.yml');

    if (await fileExists(configUri)) {
      return folder.uri.fsPath;
    }
  }

  return undefined;
}

async function autoOpenProjectViewForRayfinWorkspace(): Promise<void> {
  try {
    const workspaceFolder = await findRayfinWorkspaceFolder();

    if (!workspaceFolder) {
      return;
    }

    const configUri = vscode.Uri.joinPath(
      vscode.Uri.file(workspaceFolder),
      'rayfin',
      'rayfin.yml'
    );
    const yaml = await readTextFile(configUri);
    const config = parseRayfinYaml(yaml);

    if (isAutoOpenDismissed(ext.context, config.id)) {
      return;
    }

    // Only auto-deploy when the project was just created via the
    // "Open in VS Code" URI handler flow. Regular workspace opens
    // show the setup view but never auto-trigger deployment.
    // The flag is read here but NOT consumed — it is cleared only when
    // the deploy step actually fires (in the runDeploy router mutation)
    // so it survives restarts that stall before reaching deployment.
    const autoDeployEnabled = hasPendingUriDeploy(ext.context, config.id);

    ProjectViewController.show({ workspaceFolder, autoDeployEnabled });
  } catch (error) {
    ext.outputChannel.appendLine(
      `Failed to auto-open Project Rayfin view: ${String(error)}`
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  ext.context = context;
  ext.outputChannel = vscode.window.createOutputChannel('Project Rayfin');
  context.subscriptions.push(ext.outputChannel);

  ext.telemetryReporter = new TelemetryReporter();
  context.subscriptions.push(ext.telemetryReporter);

  ext.commandRunner = new VSCodeCommandRunner();
  ext.commandRunner.warmUp();
  context.subscriptions.push(ext.commandRunner);

  if (vscode.l10n.uri) {
    l10n.config({
      contents: vscode.l10n.bundle ?? {},
    });
  }

  // Register the bundled Rayfin plugin for Copilot Chat
  registerCopilotPlugin(context);

  context.subscriptions.push(
    registerTrackedCommand('rayfin.signInWithMicrosoft', signIn)
  );

  context.subscriptions.push(
    registerTrackedCommand('rayfin.up', (options?: UpOptions) => up(options))
  );

  context.subscriptions.push(
    registerTrackedCommand('rayfin.upStaticDeploy', () => upStaticDeploy())
  );

  context.subscriptions.push(
    vscode.lm.registerTool(UP_TOOL_NAME, new UpTool())
  );

  context.subscriptions.push(
    registerTrackedCommand('rayfin.openProjectView', () => {
      ProjectViewController.show();
    })
  );

  context.subscriptions.push(
    registerTrackedCommand('rayfin.createProject', createProject)
  );

  context.subscriptions.push(
    registerTrackedCommand(
      'rayfin.openGettingStarted',
      (options?: { payload?: unknown }) => {
        GettingStartedViewController.show({
          payload: options?.payload as UriPayload | undefined,
        });
      }
    )
  );

  const uriHandler = new RayfinUriHandler();
  const trackedUriHandler: vscode.UriHandler = {
    handleUri: (...args) => {
      const version: string =
        (ext.context.extension.packageJSON as { version?: string }).version ??
        'unknown';
      const ctx = new InvocationContext('rayfin-vscode', version);
      ctx.setCommand('rayfin.handleUri', []);
      return uriHandler
        .handleUri(...args)
        .then(
          (result) => {
            ctx.markSuccess();
            return result;
          },
          (error) => {
            ctx.markFailure(
              error instanceof Error ? error : new Error(String(error))
            );
            throw error;
          }
        )
        .finally(() => {
          const event = ctx.finalize(getEnvironmentInfo());
          ext.telemetryReporter?.sendCommandEvent(event);
        });
    },
  };
  context.subscriptions.push(
    vscode.window.registerUriHandler(trackedUriHandler)
  );

  if (vscode.workspace.isTrusted) {
    void autoOpenProjectViewForRayfinWorkspace();
  } else {
    const trustDisposable = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      trustDisposable.dispose();
      void autoOpenProjectViewForRayfinWorkspace();
    });
    context.subscriptions.push(trustDisposable);
  }
}

export function deactivate(): void {
  // clean-up
}
