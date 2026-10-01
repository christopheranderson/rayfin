/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { type UriPayload } from '../../commands/RayfinUriHandler';
import { ext } from '../../extensionVariables';
import { OutputChannelLogger } from '../../services/OutputChannelLogger';
import { ProjectViewService } from '../../services/ProjectViewService';
import { WebviewController } from '../api/extension-server/WebviewController';
import { type ProjectRouterContext } from '../projectView/projectViewRouter';

/**
 * Configuration passed to the Getting Started webview at creation time.
 */
export interface GettingStartedViewConfig {
  /** Optional URI payload data from the Fabric portal deep link. */
  payload?: UriPayload;
}

export interface GettingStartedViewControllerOptions {
  /** URI handler payload to pre-populate the view. */
  payload?: UriPayload;
  viewColumn?: vscode.ViewColumn;
}

/**
 * Controller for the "Getting Started" webview panel.
 *
 * Uses a singleton pattern so only one Getting Started panel is shown at a
 * time.  If the panel is already open, calling `show()` will reveal it.
 */
export class GettingStartedViewController extends WebviewController<GettingStartedViewConfig> {
  private static currentInstance: GettingStartedViewController | undefined;

  public static show(
    options: GettingStartedViewControllerOptions = {}
  ): GettingStartedViewController {
    const currentInstance = GettingStartedViewController.currentInstance;

    if (currentInstance && !currentInstance.isDisposed) {
      currentInstance.revealToForeground(
        options.viewColumn ?? vscode.ViewColumn.One
      );
      return currentInstance;
    }

    const controller = new GettingStartedViewController(options);
    GettingStartedViewController.currentInstance = controller;
    controller.onDisposed(() => {
      if (GettingStartedViewController.currentInstance === controller) {
        GettingStartedViewController.currentInstance = undefined;
      }
    });

    return controller;
  }

  constructor(options: GettingStartedViewControllerOptions = {}) {
    const config: GettingStartedViewConfig = {
      payload: options.payload,
    };

    super(
      ext.context,
      'Project Rayfin: Start',
      'gettingStartedView',
      config,
      options.viewColumn
    );

    // Set up a ProjectViewService so that `projectView.*` procedures
    // (checkPrerequisite, checkPrerequisites, etc.) work from this webview.
    // The first argument (CommandRunner) is omitted because the Getting
    // Started view only uses prerequisite checks, not terminal commands.
    const logger = new OutputChannelLogger(ext.outputChannel);
    const service = new ProjectViewService(undefined, logger);
    this.registerDisposable(service);

    const trpcContext: ProjectRouterContext = {
      webviewName: 'gettingStartedView',
      service,
    };

    this.setupTrpc(trpcContext);
  }
}
