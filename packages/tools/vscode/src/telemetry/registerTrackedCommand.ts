/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wraps `vscode.commands.registerCommand` with automatic telemetry
 * instrumentation using the shared {@link InvocationContext}.
 *
 * Every command registered through this helper emits a
 * `rayfin/command` event with timing, outcome, and safe metadata.
 */

import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';

import { getEnvironmentInfo } from './env';

/**
 * Register a VS Code command with automatic telemetry tracking.
 *
 * The returned disposable should be pushed onto `context.subscriptions`
 * in `activate()` just like a normal `registerCommand` call.
 */
export function registerTrackedCommand(
  commandId: string,

  handler: (...args: any[]) => unknown
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, async (...args) => {
    const version: string =
      (ext.context.extension.packageJSON as { version?: string }).version ??
      'unknown';
    const ctx = new InvocationContext('rayfin-vscode', version);
    ctx.setCommand(commandId, []);

    try {
      await handler(...args);
      ctx.markSuccess();
    } catch (error) {
      ctx.markFailure(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    } finally {
      const event = ctx.finalize(getEnvironmentInfo());
      ext.telemetryReporter?.sendCommandEvent(event);
    }
  });
}
