/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { getFabricSession } from '../services/auth';

export async function signIn(): Promise<void> {
  try {
    const session = await getFabricSession({ createIfNone: true });

    if (!session) {
      return;
    }

    void vscode.window.showInformationMessage(
      vscode.l10n.t('Signed in as {0}', session.account.label)
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Failed to sign in: {0}', errorMessage)
    );
  }
}
