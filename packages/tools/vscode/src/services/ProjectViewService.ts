/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  noopLogger,
  type Logger,
} from '@microsoft/rayfin-tools-common/_internal';
import {
  checkAllPrereqs,
  type CommandRunOptions,
  evaluateDockerGhcrAuth,
  evaluatePrereq,
  PREREQ_DEFINITIONS,
  type CheckResult,
  type CommandRunner,
} from '@microsoft/rayfin-tools-common/_internal/checks';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';

import { getFabricScopes, getFabricSessionProvider } from './auth';

/**
 * Service layer for the project view webview.
 *
 * Delegates prerequisite / auth evaluation to pure functions in
 * `@microsoft/rayfin-tools-common` and owns VS Code-specific interactions
 * (terminal creation, folder pickers).
 *
 * By default uses the shared {@link ext.commandRunner} singleton which is
 * created once in `activate()` and stays warm for the lifetime of the
 * extension. A custom `CommandRunner` can be injected for testing.
 */
export class ProjectViewService implements vscode.Disposable {
  private readonly _runner: CommandRunner;
  private readonly _log: Logger;

  constructor(runner?: CommandRunner, logger?: Logger) {
    this._log = logger ?? noopLogger;
    this._runner = runner ?? ext.commandRunner;
  }

  dispose(): void {
    // The shared runner is owned by the extension context, not by us.
  }

  // ── Checks (read-only, idempotent) ──────────────────────────────────

  async checkPrerequisites(
    options: CommandRunOptions = {}
  ): Promise<CheckResult[]> {
    return this.measure('checkPrerequisites', () =>
      checkAllPrereqs(this._runner, this._log, options)
    );
  }

  async checkPrerequisite(
    name: string,
    options: CommandRunOptions = {}
  ): Promise<CheckResult> {
    const definition = PREREQ_DEFINITIONS.find(
      (prereq) => prereq.name === name
    );
    if (!definition) {
      return {
        status: 'fail',
        name,
        detail: 'Unknown prerequisite',
      };
    }

    return this.measure(`checkPrerequisite:${definition.name}`, async () => {
      this._log.info(`Checking prerequisite: ${definition.name}`);
      this._log.debug(`Running: ${definition.command}`);
      const output = await this._runner.run(definition.command, options);
      const result = evaluatePrereq(definition, output);
      this._log.info(`${definition.name}: ${result.status} (${result.detail})`);
      return result;
    });
  }

  private async measure<T>(label: string, run: () => Promise<T>): Promise<T> {
    const startedAt = globalThis.performance.now();
    try {
      return await run();
    } finally {
      const elapsedMs = Math.round(globalThis.performance.now() - startedAt);
      this._log.debug(`${label} completed in ${elapsedMs}ms`);
    }
  }

  // ── Actions (side-effects via VS Code terminals / programmatic) ───

  private getOrCreateTerminal(name: string, cwd?: string): vscode.Terminal {
    const existing = vscode.window.terminals.find((t) => t.name === name);
    if (existing) {
      existing.show();
      return existing;
    }
    const terminal = vscode.window.createTerminal({
      name,
      ...(cwd ? { cwd: vscode.Uri.file(cwd) } : {}),
    });
    terminal.show();
    return terminal;
  }

  // ── Docker GHCR auth ────────────────────────────────────────────────

  async checkDockerGhcrAuth(
    options: CommandRunOptions = {}
  ): Promise<CheckResult> {
    return this.measure('checkDockerGhcrAuth', async () => {
      this._log.info('Checking Docker GHCR auth…');
      const dockerConfig = await this._runner.run(
        'cat ~/.docker/config.json',
        options
      );
      const result = evaluateDockerGhcrAuth(dockerConfig);
      this._log.info(`Container Registry: ${result.status} (${result.detail})`);
      return result;
    });
  }

  async loginDockerGhcr(): Promise<CheckResult> {
    return this.measure('loginDockerGhcr', async () => {
      this._log.info('Logging in to ghcr.io…');
      const session = await vscode.authentication.getSession(
        'github',
        ['repo', 'read:packages'],
        { silent: true }
      );
      if (!session) {
        return {
          status: 'fail',
          name: 'Container Registry',
          detail: 'Not signed in to GitHub',
        };
      }

      const username = session.account.label;
      // Pipe the token via echo to avoid exposing it in command args/history.
      // The token is already available in the auth session.
      const result = await this._runner.run(
        `echo ${JSON.stringify(session.accessToken)} | docker login ghcr.io -u ${JSON.stringify(username)} --password-stdin`
      );

      if (result.exitCode === 0) {
        this._log.info(`GHCR login succeeded for ${username}`);
        return {
          status: 'pass',
          name: 'Container Registry',
          detail: 'ghcr.io',
        };
      }

      this._log.info(`GHCR login failed: ${result.stderr || result.stdout}`);
      return {
        status: 'fail',
        name: 'Container Registry',
        detail: 'Login failed',
      };
    });
  }

  // ── Microsoft Fabric auth ──────────────────────────────────────────

  async checkMicrosoftAuth(): Promise<CheckResult> {
    return this.measure('checkMicrosoftAuth', async () => {
      this._log.info('Checking Microsoft Fabric auth…');
      const session = await vscode.authentication.getSession(
        getFabricSessionProvider(),
        getFabricScopes(),
        { silent: true }
      );
      if (!session) {
        return {
          status: 'fail',
          name: 'Microsoft Account',
          detail: 'Not signed in',
        };
      }
      this._log.info(
        `Microsoft Fabric auth confirmed for ${session.account.label}`
      );
      return {
        status: 'pass',
        name: 'Microsoft Account',
        detail: session.account.label,
      };
    });
  }

  async signInMicrosoft(force = false): Promise<CheckResult> {
    return this.measure('signInMicrosoft', async () => {
      this._log.info(
        force ? 'Switching Microsoft account…' : 'Signing in to Microsoft…'
      );

      const session = await vscode.authentication.getSession(
        getFabricSessionProvider(),
        getFabricScopes(),
        force
          ? { clearSessionPreference: true, createIfNone: true }
          : { createIfNone: true }
      );
      if (!session) {
        return {
          status: 'fail',
          name: 'Microsoft Account',
          detail: 'Sign-in was cancelled',
        };
      }
      this._log.info(
        `Microsoft Fabric sign-in succeeded for ${session.account.label}`
      );
      return {
        status: 'pass',
        name: 'Microsoft Account',
        detail: session.account.label,
      };
    });
  }

  openNpmInstallTerminal(folder: string): void {
    this._log.info('Opening terminal for npm install');
    const terminal = this.getOrCreateTerminal('Rayfin: npm install', folder);
    terminal.sendText('npm install');
  }
}
