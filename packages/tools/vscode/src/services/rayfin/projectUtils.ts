/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { ext } from '../../extensionVariables';
import { fileExists } from '../../utils/fs';

/**
 * Finds the Rayfin project root by traversing upwards from the given
 * start URI until it finds a directory containing `rayfin/rayfin.yml`.
 *
 * Works in both desktop and web extension hosts.
 *
 * @param startUri - The URI to start searching from (e.g. workspace folder URI).
 * @returns The URI of the Rayfin project root.
 * @throws `Error` if the Rayfin project root cannot be found.
 */
export async function findRayfinProjectRoot(
  startUri: vscode.Uri
): Promise<vscode.Uri> {
  let currentUri = startUri;

  while (true) {
    const rayfinConfigUri = vscode.Uri.joinPath(
      currentUri,
      'rayfin',
      'rayfin.yml'
    );

    if (await fileExists(rayfinConfigUri)) {
      ext.outputChannel.appendLine(
        `Found Rayfin project root: ${currentUri.toString(true)}`
      );
      return currentUri;
    }

    const parentUri = vscode.Uri.joinPath(currentUri, '..');

    // Reached filesystem root
    if (parentUri.path === currentUri.path) {
      throw new Error(
        `Could not find Rayfin project root. No 'rayfin/rayfin.yml' file found in '${startUri.toString(true)}' or any of its parent directories.`
      );
    }

    currentUri = parentUri;
  }
}
