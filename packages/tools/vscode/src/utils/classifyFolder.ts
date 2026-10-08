/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { fileExists } from './fs';

/** Classification of a folder's contents. */
export type FolderKind = 'empty' | 'rayfin' | 'non-rayfin';

export interface FolderClassification {
  kind: FolderKind;
  exists: boolean;
}

/**
 * Inspect a folder and classify it as empty, a Rayfin project, or
 * a non-Rayfin occupied directory.
 *
 * Non-existent folders are treated as `empty` (valid target for new projects).
 * Dotfiles are ignored when determining emptiness.
 */
export async function classifyFolder(
  folderUri: vscode.Uri
): Promise<FolderClassification> {
  const exists = await fileExists(folderUri);
  if (!exists) {
    return { kind: 'empty', exists: false };
  }

  const configUri = vscode.Uri.joinPath(folderUri, 'rayfin', 'rayfin.yml');
  if (await fileExists(configUri)) {
    return { kind: 'rayfin', exists: true };
  }

  try {
    const entries = await vscode.workspace.fs.readDirectory(folderUri);
    const nonDotEntries = entries.filter(([name]) => !name.startsWith('.'));
    if (nonDotEntries.length === 0) {
      return { kind: 'empty', exists: true };
    }
  } catch {
    // I/O or permission error — treat as occupied to be safe.
  }

  return { kind: 'non-rayfin', exists: true };
}
