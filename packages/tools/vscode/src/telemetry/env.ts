/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Helpers for resolving environment info within the VS Code extension.
 *
 * The shared telemetry core does not access `process` or other Node.js
 * globals. This module bridges that gap for the extension host.
 *
 * Note: The extension's tsconfig targets both browser and Node.js. We
 * use `globalThis.process` to access Node-only properties in a way
 * that doesn't fail type-checking under the DOM/WebWorker lib set.
 */

import type { EnvironmentInfo } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import * as vscode from 'vscode';

const nodeProcess = (globalThis as any).process as
  | { platform: string; version: string }
  | undefined;

/** Resolve the current platform environment info for telemetry finalization. */
export function getEnvironmentInfo(): EnvironmentInfo {
  // Web extension host (Codespaces, github.dev, vscode.dev, etc.) has no
  // Node `process`. Report the VS Code-provided app host so we can still
  // distinguish web surfaces in telemetry.
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    return {
      osType: 'web',
      osVersion: vscode.env.appHost,
      nodeVersion: 'unknown',
    };
  }

  return {
    osType: nodeProcess?.platform ?? 'unknown',
    osVersion: 'unknown',
    nodeVersion: nodeProcess?.version ?? 'unknown',
  };
}
