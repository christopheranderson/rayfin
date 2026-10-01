/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';

const loadRayfinConfigMock = vi.fn();
const loadEnvironmentVariablesMock = vi.fn();
const getFabricSessionMock = vi.fn();
const updateRayfinConfigMock = vi.fn();
const writeDeploymentEnvFileMock = vi.fn();
const staticZip = new Uint8Array([80, 75, 3, 4]);

vi.mock('../services/auth', () => ({
  getFabricSession: getFabricSessionMock,
}));

vi.mock('../services/rayfin/config', () => ({
  loadRayfinConfig: loadRayfinConfigMock,
  loadEnvironmentVariables: loadEnvironmentVariablesMock,
  updateRayfinConfig: updateRayfinConfigMock,
}));

vi.mock('../services/rayfin/envFabric', () => ({
  readLatestDeployment: vi.fn(async () => undefined),
  warnAboutLegacyMigrations: vi.fn(async () => undefined),
  resolveDeploymentFromEnvFiles: vi.fn(async () => ({
    workspaceName: 'My workspace',
    deployment: {
      fabricApiUrl: 'https://api.fabric.microsoft.com',
      fabricWorkspaceId: 'workspace-id',
      fabricItemId: 'item-id',
    },
  })),
  extractTenantIdFromToken: vi.fn(),
  writeDeploymentEnvFile: writeDeploymentEnvFileMock,
}));

vi.mock('../services/rayfin/projectUtils', () => ({
  findRayfinProjectRoot: vi.fn(async (uri: vscode.Uri) => uri),
}));

vi.mock('../services/static/staticHosting', () => ({
  validateStaticFolder: vi.fn(async () => ({ exists: true, empty: false })),
  packageStaticFolder: vi.fn(async () => staticZip),
  formatBytes: vi.fn(() => '0 bytes'),
  logStatic: vi.fn(),
}));

describe('up config validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadEnvironmentVariablesMock.mockResolvedValue(new Map());
    getFabricSessionMock.mockRejectedValue(new Error('Reached authentication'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Unexpected network call'))
    );
    ext.outputChannel = {
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as unknown as vscode.OutputChannel;
  });

  afterEach(() => vi.unstubAllGlobals());

  it('shows a clear error when services.data.enabled is missing', async () => {
    loadRayfinConfigMock.mockResolvedValue({
      id: 'my-project',
      services: {
        data: {},
      },
    });

    const { up } = await import('../commands/up');

    await expect(up()).rejects.toThrow(
      "Invalid rayfin.yml: 'services.data.enabled' must be a boolean."
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Up failed: Invalid rayfin.yml: 'services.data.enabled' must be a boolean."
    );
    expect(vscode.authentication.getSession).not.toHaveBeenCalled();
  });

  function config(auth: unknown, enabled = true) {
    return {
      id: 'my-project',
      services: {
        auth: { enabled: false },
        data: { enabled: false },
        functions: { enabled, auth },
        staticHosting: { enabled: true, folder: 'dist' },
      },
    };
  }

  describe('up Functions preflight', () => {
    async function deploy(): Promise<void> {
      const { up } = await import('../commands/up');
      await up().catch(() => undefined);
    }

    it.each([true, false])(
      'rejects delegated auth before authentication or writes (enabled=%s)',
      async (enabled) => {
        loadRayfinConfigMock.mockResolvedValue(
          config({ type: 'delegated' }, enabled)
        );
        await deploy();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining(
            'Only application authentication is supported.'
          )
        );
        expect(getFabricSessionMock).not.toHaveBeenCalled();
        expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      }
    );

    it.each([true, false])(
      'accepts explicit application auth without opt-in (enabled=%s)',
      async (enabled) => {
        const auth = { type: 'application' };
        const authored = config(auth, enabled);
        loadRayfinConfigMock.mockResolvedValue(authored);
        await deploy();
        expect(getFabricSessionMock).toHaveBeenCalledOnce();
        expect(authored.services.functions.auth).toBe(auth);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining('Reached authentication')
        );
      }
    );

    it('accepts disabled Functions without auth', async () => {
      loadRayfinConfigMock.mockResolvedValue(config(undefined, false));
      await deploy();
      expect(getFabricSessionMock).toHaveBeenCalledOnce();
    });

    it.each([
      { auth: undefined },
      { auth: {} },
      { auth: null },
      { auth: 'application' },
      { auth: [] },
      { auth: { type: null } },
      { auth: { type: 'unknown' } },
      { auth: { type: 'delegated' } },
    ])(
      'rejects missing or invalid authentication even with the old flag: %j',
      async ({ auth }) => {
        loadRayfinConfigMock.mockResolvedValue(config(auth));
        loadEnvironmentVariablesMock.mockResolvedValue(
          new Map([['RAYFIN_FEATURE_FLAGS', 'functions-application-auth']])
        );
        await deploy();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining('Invalid services.functions.auth')
        );
        expect(getFabricSessionMock).not.toHaveBeenCalled();
        expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      }
    );
  });

  describe('static-only deployment', () => {
    it.each([
      {
        name: 'missing local auth',
        auth: undefined,
        enabled: true,
        recordedAuth: 'application',
      },
      {
        name: 'delegated local auth',
        auth: { type: 'delegated' },
        enabled: true,
        recordedAuth: 'application',
      },
      {
        name: 'disabled Functions with stale delegated auth',
        auth: { type: 'delegated' },
        enabled: false,
        recordedAuth: 'application',
      },
      {
        name: 'disabled Functions without auth',
        auth: undefined,
        enabled: false,
        recordedAuth: 'application',
      },
      {
        name: 'application local auth and legacy delegated remote auth',
        auth: { type: 'application' },
        enabled: true,
        recordedAuth: 'delegated',
      },
      {
        name: 'disabled application local auth and legacy delegated remote auth',
        auth: { type: 'application' },
        enabled: false,
        recordedAuth: 'delegated',
      },
      {
        name: 'local Functions absent from the recorded settings',
        auth: { type: 'application' },
        enabled: true,
        recordedAuth: undefined,
      },
    ])(
      'uploads content and preserves recorded Functions with $name',
      async ({ auth, enabled, recordedAuth }) => {
        const authored = config(auth, enabled);
        authored.services.auth.enabled = true;
        loadRayfinConfigMock.mockResolvedValue(authored);
        getFabricSessionMock.mockResolvedValue({ accessToken: 'mock-token' });
        vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
          undefined
        );
        const recorded = {
          auth: { enabled: true, allowedRedirectUris: ['https://old.example'] },
          data: { enabled: false },
          staticHosting: { enabled: true, anonymousAccess: false },
          ...(recordedAuth
            ? {
                functions: {
                  enabled: true,
                  auth: { type: recordedAuth },
                  path: 'recorded-functions',
                  buildCommand: 'recorded-build',
                },
              }
            : {}),
        };
        const hostingUrl = 'https://app.example/index.html';
        const fetchMock = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true, hostingUrl }))
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ serviceSettings: recorded }))
          )
          .mockResolvedValueOnce(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);

        const { upStaticDeploy } = await import('../commands/upStaticDeploy');
        await upStaticDeploy();

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock).toHaveBeenNthCalledWith(
          1,
          expect.stringContaining(
            '/workspaces/workspace-id/appBackends/item-id/__private/webapp/deploy'
          ),
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Content-Type': 'application/zip',
            }),
            body: staticZip,
          })
        );
        const settingsUrl = expect.stringContaining(
          '/workspaces/workspace-id/appBackends/item-id/__private/projectRuntimeSettings'
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
          2,
          settingsUrl,
          expect.objectContaining({ headers: expect.any(Object) })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
          3,
          settingsUrl,
          expect.objectContaining({ method: 'POST' })
        );
        const body: unknown = JSON.parse(
          String(fetchMock.mock.calls[2][1]?.body)
        );
        const updatedAuth = {
          enabled: true,
          allowedRedirectUris: ['https://app.example'],
        };
        expect(body).toEqual({
          ...recorded,
          auth: updatedAuth,
          packageVersions: { '@microsoft/rayfin-cli': expect.any(String) },
        });
        expect(authored.services.functions).toEqual({ enabled, auth });
        expect(updateRayfinConfigMock).toHaveBeenCalledWith(
          { services: { ...authored.services, auth: updatedAuth } },
          vscode.workspace.workspaceFolders?.[0].uri
        );
        expect(writeDeploymentEnvFileMock).toHaveBeenCalledWith(
          vscode.workspace.workspaceFolders?.[0].uri,
          'My workspace',
          expect.objectContaining({ hostingUrl })
        );
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
          `Static content deployed — ${hostingUrl}`,
          'Open App'
        );
      }
    );
  });
});
