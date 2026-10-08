/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { StaticHostingConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { zipSync } from 'fflate';
import * as vscode from 'vscode';

import { ext } from '../../extensionVariables';

/** Maximum compressed ZIP size accepted by the deploy API (100 MB). */
export const MAX_ZIP_SIZE_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface StaticFolderValidation {
  exists: boolean;
  empty: boolean;
  resolvedUri: vscode.Uri;
  message?: string;
  fileCount: number;
  totalSizeBytes: number;
}

/**
 * Validate that the configured static folder exists and contains files.
 * Uses `vscode.workspace.fs` — works in both desktop and web extension hosts.
 */
export async function validateStaticFolder(
  projectRootUri: vscode.Uri,
  config: StaticHostingConfig
): Promise<StaticFolderValidation> {
  const resolvedUri = vscode.Uri.joinPath(
    projectRootUri,
    config.root || '.',
    config.folder
  );

  const fail = (message: string): StaticFolderValidation => ({
    exists: false,
    empty: true,
    resolvedUri,
    message,
    fileCount: 0,
    totalSizeBytes: 0,
  });

  try {
    const stat = await vscode.workspace.fs.stat(resolvedUri);
    if (stat.type !== vscode.FileType.Directory) {
      return fail(`Not a directory: ${resolvedUri.toString(true)}`);
    }
  } catch {
    return fail(`Static folder not found: ${resolvedUri.toString(true)}`);
  }

  const { fileCount, totalSizeBytes } = await countFiles(resolvedUri);
  if (fileCount === 0) {
    return {
      exists: true,
      empty: true,
      resolvedUri,
      message: 'Static folder is empty',
      fileCount: 0,
      totalSizeBytes: 0,
    };
  }

  return {
    exists: true,
    empty: false,
    resolvedUri,
    fileCount,
    totalSizeBytes,
  };
}

async function countFiles(
  dirUri: vscode.Uri
): Promise<{ fileCount: number; totalSizeBytes: number }> {
  let fileCount = 0;
  let totalSizeBytes = 0;

  const entries = await vscode.workspace.fs.readDirectory(dirUri);
  for (const [name, type] of entries) {
    const childUri = vscode.Uri.joinPath(dirUri, name);
    if (type === vscode.FileType.Directory) {
      const sub = await countFiles(childUri);
      fileCount += sub.fileCount;
      totalSizeBytes += sub.totalSizeBytes;
    } else if (type === vscode.FileType.File) {
      fileCount++;
      const stat = await vscode.workspace.fs.stat(childUri);
      totalSizeBytes += stat.size;
    }
  }

  return { fileCount, totalSizeBytes };
}

// ---------------------------------------------------------------------------
// ZIP packaging (using fflate — browser-compatible, no Node.js deps)
// ---------------------------------------------------------------------------

/**
 * Package the static folder into a ZIP Uint8Array.
 * Rejects if the compressed size exceeds {@link MAX_ZIP_SIZE_BYTES}.
 */
export async function packageStaticFolder(
  folderUri: vscode.Uri
): Promise<Uint8Array> {
  const files = await collectFiles(folderUri, '');
  const zipped = zipSync(files, { level: 9 });

  if (zipped.byteLength > MAX_ZIP_SIZE_BYTES) {
    throw new Error(
      `Compressed package size (${formatBytes(zipped.byteLength)}) exceeds the 100 MB limit. ` +
        'Reduce the number or size of files in your static folder.'
    );
  }

  return zipped;
}

async function collectFiles(
  dirUri: vscode.Uri,
  prefix: string
): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {};
  const entries = await vscode.workspace.fs.readDirectory(dirUri);

  for (const [name, type] of entries) {
    const childUri = vscode.Uri.joinPath(dirUri, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;

    if (type === vscode.FileType.Directory) {
      const subFiles = await collectFiles(childUri, relativePath);
      Object.assign(result, subFiles);
    } else if (type === vscode.FileType.File) {
      result[relativePath] = await vscode.workspace.fs.readFile(childUri);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Redirect URI management
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deploy response type
// ---------------------------------------------------------------------------

/** Response from `/api/webapp/deploy`. */
export interface StaticDeployResponse {
  success: boolean;
  deploymentId?: string;
  hostingUrl?: string;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function logStatic(message: string): void {
  ext.outputChannel.appendLine(`[static-hosting] ${message}`);
}
