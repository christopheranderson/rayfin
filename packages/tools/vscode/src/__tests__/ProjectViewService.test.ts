/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  CommandOutput,
  CommandRunner,
} from '@microsoft/rayfin-tools-common/_internal/checks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';

// ── Mocks ─────────────────────────────────────────────────────────────

const fileExistsMock = vi.fn();
const readTextFileMock = vi.fn();
const writeTextFileMock = vi.fn();

vi.mock('../utils/fs', () => ({
  fileExists: fileExistsMock,
  readTextFile: readTextFileMock,
  writeTextFile: writeTextFileMock,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// ── Mock CommandRunner ────────────────────────────────────────────────

function createMockRunner(
  responses: Record<string, CommandOutput>
): CommandRunner {
  return {
    run: vi.fn(async (command: string) => {
      for (const [pattern, output] of Object.entries(responses)) {
        if (command.includes(pattern)) return output;
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    }),
  };
}

const ok = (stdout: string): CommandOutput => ({
  stdout,
  stderr: '',
  exitCode: 0,
});
const fail = (stderr = ''): CommandOutput => ({
  stdout: '',
  stderr,
  exitCode: 1,
});

// ── Test suite ────────────────────────────────────────────────────────

describe('ProjectViewService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    ext.outputChannel = {
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as unknown as vscode.OutputChannel;

    ext.context = {
      environmentVariableCollection: {
        replace: vi.fn(),
      },
    } as unknown as vscode.ExtensionContext;

    (
      vscode.authentication.getSession as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      accessToken: 'mock-token',
      account: { label: 'mock-user' },
    });

    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    fileExistsMock.mockResolvedValue(false);
    readTextFileMock.mockResolvedValue('');
    writeTextFileMock.mockResolvedValue(undefined);
  });

  async function createService(responses: Record<string, CommandOutput> = {}) {
    const runner = createMockRunner(responses);
    const { ProjectViewService } =
      await import('../services/ProjectViewService');
    return { service: new ProjectViewService(runner), runner };
  }

  // ── checkPrerequisite ─────────────────────────────────────────────

  describe('checkPrerequisite', () => {
    it('returns pass when Node.js version meets minimum', async () => {
      const { service } = await createService({
        'node --version': ok('v20.11.0'),
      });

      const result = await service.checkPrerequisite('Node.js');

      expect(result.status).toBe('pass');
      expect(result.name).toBe('Node.js');
    });

    it('returns warn when Node.js version is below minimum', async () => {
      const { service } = await createService({
        'node --version': ok('v18.0.0'),
      });

      const result = await service.checkPrerequisite('Node.js');

      expect(result.status).toBe('warn');
      expect(result.detail).toContain('20');
    });

    it('returns fail when command not found', async () => {
      const { service } = await createService({
        'node --version': fail(),
      });

      const result = await service.checkPrerequisite('Node.js');

      expect(result.status).toBe('fail');
      expect(result.detail).toBe('Not found');
    });

    it('returns fail for unknown prerequisite name', async () => {
      const { service } = await createService();

      const result = await service.checkPrerequisite('UnknownTool');

      expect(result.status).toBe('fail');
      expect(result.detail).toBe('Unknown prerequisite');
    });
  });

  // ── checkPrerequisites ────────────────────────────────────────────

  describe('checkPrerequisites', () => {
    it('returns results for all defined prerequisites', async () => {
      const { service } = await createService({
        'node --version': ok('v20.11.0'),
        'docker --version': ok('Docker version 24.0.7'),
      });

      const results = await service.checkPrerequisites();

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('Node.js');
      expect(results[0].status).toBe('pass');
      expect(results[1].name).toBe('Docker');
      expect(results[1].status).toBe('pass');
    });
  });

  // ── checkDockerGhcrAuth ───────────────────────────────────────────

  describe('checkDockerGhcrAuth', () => {
    it('returns pass when ghcr.io is in docker config', async () => {
      const { service } = await createService({
        'cat ~/.docker/config.json': ok(
          JSON.stringify({ auths: { 'ghcr.io': {} } })
        ),
      });

      const result = await service.checkDockerGhcrAuth();

      expect(result.status).toBe('pass');
      expect(result.detail).toBe('ghcr.io');
    });

    it('returns fail when docker config not found', async () => {
      const { service } = await createService({
        'cat ~/.docker/config.json': fail(),
      });

      const result = await service.checkDockerGhcrAuth();

      expect(result.status).toBe('fail');
    });
  });

  // ── loginDockerGhcr ───────────────────────────────────────────────

  describe('loginDockerGhcr', () => {
    it('returns pass on successful login', async () => {
      const { service } = await createService({
        'docker login': ok('Login Succeeded'),
      });

      const result = await service.loginDockerGhcr();

      expect(result.status).toBe('pass');
    });

    it('returns fail when not signed in to GitHub', async () => {
      (
        vscode.authentication.getSession as ReturnType<typeof vi.fn>
      ).mockResolvedValue(undefined);
      const { service } = await createService();

      const result = await service.loginDockerGhcr();

      expect(result.status).toBe('fail');
      expect(result.detail).toBe('Not signed in to GitHub');
    });

    it('returns fail on docker login failure', async () => {
      const { service } = await createService({
        'docker login': fail('unauthorized'),
      });

      const result = await service.loginDockerGhcr();

      expect(result.status).toBe('fail');
      expect(result.detail).toBe('Login failed');
    });
  });

  // ── checkMicrosoftAuth / signInMicrosoft ──────────────────────────

  describe('checkMicrosoftAuth', () => {
    it('returns pass when session exists', async () => {
      const { service } = await createService();

      const result = await service.checkMicrosoftAuth();

      expect(result.status).toBe('pass');
      expect(result.detail).toBe('mock-user');
    });

    it('returns fail when no session exists', async () => {
      (
        vscode.authentication.getSession as ReturnType<typeof vi.fn>
      ).mockResolvedValue(undefined);
      const { service } = await createService();

      const result = await service.checkMicrosoftAuth();

      expect(result.status).toBe('fail');
      expect(result.detail).toBe('Not signed in');
    });
  });

  describe('signInMicrosoft', () => {
    it('returns pass after successful sign-in', async () => {
      const { service } = await createService();

      const result = await service.signInMicrosoft();

      expect(result.status).toBe('pass');
    });

    it('returns fail when sign-in is cancelled', async () => {
      (
        vscode.authentication.getSession as ReturnType<typeof vi.fn>
      ).mockResolvedValue(undefined);
      const { service } = await createService();

      const result = await service.signInMicrosoft();

      expect(result.status).toBe('fail');
      expect(result.detail).toBe('Sign-in was cancelled');
    });
  });

  // ── Abort signal ──────────────────────────────────────────────────

  describe('abort signal', () => {
    it('throws on already-aborted signal in checkPrerequisites', async () => {
      const { service } = await createService({
        'node --version': ok('v20.11.0'),
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        service.checkPrerequisites({ signal: controller.signal })
      ).rejects.toThrow();
    });
  });
});
