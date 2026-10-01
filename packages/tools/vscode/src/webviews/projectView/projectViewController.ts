/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { parseRayfinYaml } from '@microsoft/rayfin-tools-common/_internal/config';
import * as vscode from 'vscode';

import { ext } from '../../extensionVariables';
import { OutputChannelLogger } from '../../services/OutputChannelLogger';
import { ProjectViewService } from '../../services/ProjectViewService';
import { fileExists, readTextFile } from '../../utils/fs';
import { WebviewController } from '../api/extension-server/WebviewController';

import { type ProjectRouterContext } from './projectViewRouter';

export type ViewMode = 'existing' | 'unrecognized' | 'no-workspace';

export interface ProjectViewConfig {
  mode: ViewMode;
  rayfinConfig?: RayfinConfig;
  projectRoot?: string;
  workspaceFolder?: string;
  /** When true, the setup pipeline may auto-trigger deployment. */
  autoDeployEnabled?: boolean;
}

export interface ProjectViewControllerOptions {
  workspaceFolder?: string;
  viewColumn?: vscode.ViewColumn;
  /** Allow the setup pipeline to auto-trigger deployment (URI handler flow). */
  autoDeployEnabled?: boolean;
}

export class ProjectViewController extends WebviewController<ProjectViewConfig> {
  private static readonly BASE_TITLE = 'Project Rayfin: Overview';
  private static currentInstance: ProjectViewController | undefined;

  public static show(
    options: ProjectViewControllerOptions = {}
  ): ProjectViewController {
    const currentInstance = ProjectViewController.currentInstance;

    if (currentInstance && !currentInstance.isDisposed) {
      currentInstance.revealToForeground(
        options.viewColumn ?? vscode.ViewColumn.One
      );
      return currentInstance;
    }

    const controller = new ProjectViewController(options);
    ProjectViewController.currentInstance = controller;
    controller.onDisposed(() => {
      if (ProjectViewController.currentInstance === controller) {
        ProjectViewController.currentInstance = undefined;
      }
    });

    return controller;
  }

  constructor(options: ProjectViewControllerOptions = {}) {
    const folders = vscode.workspace.workspaceFolders;
    const currentFolder = options.workspaceFolder ?? folders?.[0]?.uri.fsPath;

    // Detection will happen asynchronously after construction; start with a
    // reasonable initial mode.
    const config: ProjectViewConfig = {
      mode: currentFolder ? 'unrecognized' : 'no-workspace',
      workspaceFolder: currentFolder,
      autoDeployEnabled: options.autoDeployEnabled ?? false,
    };

    super(
      ext.context,
      ProjectViewController.BASE_TITLE,
      'projectView',
      config,
      options.viewColumn
    );

    const logger = new OutputChannelLogger(ext.outputChannel);
    const service = new ProjectViewService(undefined, logger);
    this.registerDisposable(service);

    const trpcContext: ProjectRouterContext = {
      webviewName: 'projectView',
      service,
      session: { id: crypto.randomUUID() },
    };

    this.setupTrpc(trpcContext);

    const configWatcher = vscode.workspace.createFileSystemWatcher(
      '**/rayfin/rayfin.yml'
    );
    const notifyWebview = () => {
      if (!this.isDisposed) {
        this.panel.webview.postMessage({ type: 'configChanged' });
        void this.updateTitle(currentFolder);
      }
    };
    configWatcher.onDidChange(notifyWebview);
    configWatcher.onDidCreate(notifyWebview);
    configWatcher.onDidDelete(notifyWebview);
    this.registerDisposable(configWatcher);

    const actionMap: Record<string, string> = {
      'Rayfin: npm install': 'npmInstall',
    };

    const terminalListener = vscode.window.onDidCloseTerminal((terminal) => {
      if (this.isDisposed) return;
      const action = actionMap[terminal.name];
      if (action) {
        this.panel.webview.postMessage({ type: 'actionComplete', action });
      }
    });
    this.registerDisposable(terminalListener);

    const shellExecListener = vscode.window.onDidEndTerminalShellExecution(
      (e) => {
        if (this.isDisposed) return;
        const action = actionMap[e.terminal.name];
        if (action) {
          if (e.exitCode === 0) {
            e.terminal.dispose();
          } else {
            this.panel.webview.postMessage({ type: 'actionComplete', action });
          }
        }
      }
    );
    this.registerDisposable(shellExecListener);

    void this.updateTitle(currentFolder);
  }

  private async updateTitle(folder: string | undefined): Promise<void> {
    if (!folder || this.isDisposed) {
      this.panel.title = ProjectViewController.BASE_TITLE;
      return;
    }

    try {
      const configUri = vscode.Uri.joinPath(
        vscode.Uri.file(folder),
        'rayfin',
        'rayfin.yml'
      );

      if (!(await fileExists(configUri))) {
        this.panel.title = ProjectViewController.BASE_TITLE;
        return;
      }

      const yaml = await readTextFile(configUri);
      const config = parseRayfinYaml(yaml);
      this.panel.title = `Project Rayfin: ${config.name}`;
    } catch {
      this.panel.title = ProjectViewController.BASE_TITLE;
    }
  }
}
