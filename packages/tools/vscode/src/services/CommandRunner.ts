/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  CommandOutput,
  CommandRunOptions,
  CommandRunner,
} from '@microsoft/rayfin-tools-common/_internal/checks';
import * as vscode from 'vscode';

const SHELL_INTEGRATION_TIMEOUT_MS = 10_000;
const COMMAND_EXECUTION_TIMEOUT_MS = 20_000;
const COMMAND_ABORTED_EXIT_CODE = 130;

/**
 * Strip ANSI escape sequences, OSC sequences (including VS Code shell
 * integration markers like `]633;…`), and other terminal control codes
 * from raw terminal output.
 */
// eslint-disable-next-line no-control-regex -- Intentional: stripping ANSI escape sequences requires matching control characters.
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const BARE_OSC_RE = /\][0-9]+;[^\x07\n]*(?:\x07)?/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// eslint-disable-next-line no-control-regex
const ANSI_LONE_ESC_RE = /\x1b[^[\]]/g;

function stripAnsi(raw: string): string {
  return (
    raw
      .replace(ANSI_OSC_RE, '')
      .replace(BARE_OSC_RE, '')
      .replace(ANSI_CSI_RE, '')
      .replace(ANSI_LONE_ESC_RE, '')
      // Zsh prompt marker that leaks into output (e.g. `% `)
      .replace(/%\s*$/gm, '')
  );
}

/**
 * CommandRunner backed by VS Code's Terminal Shell Integration API.
 *
 * Creates a single hidden terminal on first use, waits for shell integration
 * to activate, then executes commands through it. This ensures the runner
 * inherits the user's full shell environment (PATH, nvm, etc.) exactly as
 * VS Code's integrated terminal sees it.
 *
 * **Caveats**
 * - Requires VS Code ≥ 1.93 (shell integration API).
 * - stdout and stderr are merged — `CommandOutput.stderr` is always empty.
 * - If shell integration fails to activate (e.g. unsupported shell), every
 *   `run()` call returns exit code 1 with an explanatory message.
 *
 * Implements `vscode.Disposable` — the owner must call `dispose()` to clean
 * up the underlying terminal.
 */
export class VSCodeCommandRunner implements CommandRunner, vscode.Disposable {
  private _terminal: vscode.Terminal | undefined;
  private _shellIntegration: vscode.TerminalShellIntegration | undefined;
  private _initPromise: Promise<boolean> | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _executionQueue: Promise<void> = Promise.resolve();

  /**
   * Begin terminal + shell-integration initialization eagerly.
   *
   * Call this as early as possible (e.g. at construction time of the
   * owning orchestrator) so that the hidden terminal is ready by the
   * time the first `run()` call arrives from the webview.
   */
  warmUp(): void {
    void this._ensureReady();
  }

  /**
   * Tear down the current hidden terminal so the next `run()` call
   * creates a fresh one that inherits any updated environment variables
   * (e.g. those set via `EnvironmentVariableCollection`).
   */
  reset(): void {
    this._resetTerminal();
  }

  async run(
    command: string,
    options: CommandRunOptions = {}
  ): Promise<CommandOutput> {
    const nextExecution = this._executionQueue.then(
      () => this._runCommand(command, options),
      () => this._runCommand(command, options)
    );

    this._executionQueue = nextExecution.then(
      () => undefined,
      () => undefined
    );

    return nextExecution;
  }

  private async _runCommand(
    command: string,
    options: CommandRunOptions = {}
  ): Promise<CommandOutput> {
    if (options.signal?.aborted) {
      return this._createAbortedOutput(command);
    }

    const ready = await this._ensureReady();
    if (options.signal?.aborted) {
      return this._createAbortedOutput(command);
    }

    if (!ready || !this._shellIntegration) {
      return {
        stdout: '',
        stderr: 'Shell integration is not available in this terminal',
        exitCode: 1,
      };
    }

    const execution = this._shellIntegration.executeCommand(command);
    let listener: vscode.Disposable | undefined;

    // Listen for the end event to capture exit code.
    const exitCodePromise = new Promise<number>((resolve) => {
      listener = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) {
          listener?.dispose();
          resolve(e.exitCode ?? 1);
        }
      });
    });

    // read() returns an AsyncIterable<string> — must be called immediately.
    // The raw data includes ANSI escape codes and shell integration markers
    // that must be stripped before consumers see it.
    const outputPromise = (async () => {
      const chunks: string[] = [];
      for await (const data of execution.read()) {
        chunks.push(data);
      }
      return stripAnsi(chunks.join('')).trim();
    })();

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    const executionPromise = Promise.all([outputPromise, exitCodePromise])
      .then(([stdout, exitCode]) => ({
        stdout,
        stderr: '',
        exitCode,
      }))
      .catch((error) => ({
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: timedOut ? 124 : 1,
      }));

    const timeoutPromise = new Promise<CommandOutput>((resolve) => {
      timeoutHandle = globalThis.setTimeout(() => {
        timedOut = true;
        listener?.dispose();

        // Reset the shared terminal so a hung shell command cannot block future checks.
        this._resetTerminal();

        resolve({
          stdout: '',
          stderr: `Command timed out after ${COMMAND_EXECUTION_TIMEOUT_MS}ms: ${command}`,
          exitCode: 124,
        });
      }, COMMAND_EXECUTION_TIMEOUT_MS);
    });

    const abortPromise =
      options.signal !== undefined
        ? new Promise<CommandOutput>((resolve) => {
            if (options.signal?.aborted) {
              resolve(this._createAbortedOutput(command));
              return;
            }

            const onAbort = () => {
              listener?.dispose();
              this._resetTerminal();
              resolve(this._createAbortedOutput(command));
            };

            options.signal?.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => {
              options.signal?.removeEventListener('abort', onAbort);
            };
          })
        : undefined;

    try {
      return await Promise.race(
        abortPromise === undefined
          ? [executionPromise, timeoutPromise]
          : [executionPromise, timeoutPromise, abortPromise]
      );
    } finally {
      if (timeoutHandle !== undefined) {
        globalThis.clearTimeout(timeoutHandle);
      }
      listener?.dispose();
      removeAbortListener?.();
    }
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
    this._resetTerminal();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async _ensureReady(): Promise<boolean> {
    if (this._shellIntegration) {
      return true;
    }
    if (!this._initPromise) {
      this._initPromise = this._initialize();
    }
    return this._initPromise;
  }

  private _initialize(): Promise<boolean> {
    this._terminal = vscode.window.createTerminal({
      name: 'Rayfin',
      hideFromUser: true,
    });

    // Prompt the shell once so integration has work to attach to.
    this._terminal.sendText('');

    // Shell integration may already be available synchronously.
    if (this._terminal.shellIntegration) {
      this._shellIntegration = this._terminal.shellIntegration;
      return Promise.resolve(true);
    }

    // Otherwise wait for the activation event, with a timeout.
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        listener.dispose();
        this._resetTerminal();
        resolve(false);
      }, SHELL_INTEGRATION_TIMEOUT_MS);

      const listener = vscode.window.onDidChangeTerminalShellIntegration(
        (e) => {
          if (e.terminal === this._terminal) {
            clearTimeout(timeout);
            listener.dispose();
            this._shellIntegration = e.shellIntegration;
            resolve(true);
          }
        }
      );
      this._disposables.push(listener);
    });
  }

  private _createAbortedOutput(command: string): CommandOutput {
    return {
      stdout: '',
      stderr: `Command aborted: ${command}`,
      exitCode: COMMAND_ABORTED_EXIT_CODE,
    };
  }

  private _resetTerminal(): void {
    this._terminal?.dispose();
    this._terminal = undefined;
    this._shellIntegration = undefined;
    this._initPromise = undefined;
  }
}
