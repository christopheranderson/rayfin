/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

/**
 * Checks whether a file or directory exists at the given URI.
 * Works in both desktop and web extension hosts.
 */
export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a file as UTF-8 text. Works in both desktop and web extension hosts.
 */
export async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return textDecoder.decode(bytes);
}

/**
 * Writes UTF-8 text content to a file. Works in both desktop and web extension hosts.
 *
 * Note: This helper does not create parent directories.
 * Callers must ensure the target directory already exists.
 */
export async function writeTextFile(
  uri: vscode.Uri,
  content: string
): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, textEncoder.encode(content));
}
