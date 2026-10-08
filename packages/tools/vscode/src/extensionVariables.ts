/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

import type { TelemetryReporter } from './telemetry/reporter';

/**
 * Namespace for common variables used throughout the extension.
 * They must be initialized in the activate() method of extension.ts
 */
export namespace ext {
  export let context: vscode.ExtensionContext;
  export let outputChannel: vscode.OutputChannel;
  export let commandRunner: import('./services/CommandRunner').VSCodeCommandRunner;
  export let telemetryReporter: TelemetryReporter | undefined;
}
