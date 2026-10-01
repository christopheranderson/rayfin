/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type OpenFolderChoice = 'currentWindow' | 'newWindow';

/**
 * Ask the user how they want to open a folder without performing any action.
 *
 * Returns `undefined` when the user cancels the quick pick, or
 * `'alreadyOpen'` is signalled by returning `'addToWorkspace'` (no-op) when
 * the folder is already part of the workspace.
 */
export async function askOpenFolderChoice(
  targetUri: vscode.Uri
): Promise<OpenFolderChoice | undefined> {
  const alreadyOpen = vscode.workspace.workspaceFolders?.some(
    (f) => f.uri.toString() === targetUri.toString()
  );

  if (alreadyOpen) {
    // Folder already open — caller can proceed without switching windows.
    return 'currentWindow';
  }

  const currentWindow = vscode.l10n.t('$(window) Open in Current Window');
  const newWindow = vscode.l10n.t('$(empty-window) Open in New Window');

  const choice = await vscode.window.showQuickPick([currentWindow, newWindow], {
    placeHolder: vscode.l10n.t('How would you like to open the project?'),
  });

  if (!choice) {
    return undefined;
  }

  if (choice === currentWindow) {
    return 'currentWindow';
  }
  return 'newWindow';
}

/**
 * Execute the open-folder action for a previously captured choice.
 *
 * Caller is responsible for choice validity via {@link askOpenFolderChoice}.
 */
export async function executeOpenFolder(
  targetUri: vscode.Uri,
  _projectName: string,
  choice: OpenFolderChoice
): Promise<void> {
  if (choice === 'currentWindow') {
    await vscode.commands.executeCommand('vscode.openFolder', targetUri, false);
  } else {
    await vscode.commands.executeCommand('vscode.openFolder', targetUri, true);
  }
}
