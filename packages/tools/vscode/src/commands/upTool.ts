/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { up } from './up';

/**
 * Language model tool that deploys the current Rayfin project to Microsoft Fabric.
 *
 * Registered via the `languageModelTools` contribution point in package.json and
 * wired up with `vscode.lm.registerTool` in the extension activation.
 */
export const UP_TOOL_NAME = 'rayfin_up';

interface UpInput {
  workspaceName?: string;
}

const DEFAULT_WORKSPACE_NAME = 'My workspace';

export class UpTool implements vscode.LanguageModelTool<UpInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<UpInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const workspaceName = options.input.workspaceName || DEFAULT_WORKSPACE_NAME;
    try {
      const result = await up({ workspaceName, cancellationToken: token });
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully deployed the Rayfin project to Fabric workspace "${workspaceName}". ` +
            `Open the item in the Fabric portal: ${result.fabricDeepLink}`
        ),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Deployment failed: ${msg}`),
      ]);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<UpInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const workspaceName = options.input.workspaceName || DEFAULT_WORKSPACE_NAME;
    return {
      invocationMessage: vscode.l10n.t(
        'Up: Deploy to Fabric workspace "{0}"…',
        workspaceName
      ),
      confirmationMessages: {
        title: vscode.l10n.t('Up: Deploy to Fabric'),
        message: vscode.l10n.t(
          'This will deploy the current Rayfin project to Fabric workspace "{0}". Do you want to continue?',
          workspaceName
        ),
      },
    };
  }
}
