/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Logger } from '@microsoft/rayfin-tools-common/_internal';
import type * as vscode from 'vscode';

/**
 * Logger implementation that writes to a VS Code OutputChannel.
 *
 * Each message is prefixed with a level tag so the user can scan the
 * output quickly:
 *
 * ```
 * [info]  Checking prerequisites…
 * [debug] Running: node --version
 * [info]  Node.js: pass (v22.17.0)
 * ```
 */
export class OutputChannelLogger implements Logger {
  constructor(private readonly _channel: vscode.OutputChannel) {}

  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private write(
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string
  ): void {
    this._channel.appendLine(
      `[${this.formatTimestamp()}] [${level}] ${message}`
    );
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  debug(message: string): void {
    this.write('debug', message);
  }
}
