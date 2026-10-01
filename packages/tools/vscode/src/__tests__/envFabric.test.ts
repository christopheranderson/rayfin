/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';
import {
  findExistingEnvFabricFiles,
  readDeploymentEnvFile,
  readLatestDeployment,
  sanitizeWorkspaceName,
  writeDeploymentEnvFile,
} from '../services/rayfin/envFabric';

/**
 * In-memory VS Code FS mock keyed by the `path` of `vscode.Uri`-like objects
 * we construct via `vscode.Uri.joinPath`.
 */
function installFsMock(): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>();

  vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri) => {
    const bytes = store.get(uri.path);
    if (!bytes) throw new Error('ENOENT');
    return bytes;
  });
  vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(
    async (uri, content) => {
      store.set(uri.path, content);
    }
  );
  return store;
}

describe('envFabric (registry-backed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ext.outputChannel = {
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as unknown as typeof ext.outputChannel;
  });

  // ── sanitizeWorkspaceName ───────────────────────────────────────
  describe('sanitizeWorkspaceName', () => {
    it('lowercases and replaces spaces with hyphens', () => {
      expect(sanitizeWorkspaceName('My Workspace')).toBe('my-workspace');
    });

    it('strips unicode characters', () => {
      expect(sanitizeWorkspaceName('Tëst — Ñame')).toBe('tst-ame');
    });

    it('handles empty string', () => {
      expect(sanitizeWorkspaceName('')).toBe('');
    });
  });

  // ── writeDeploymentEnvFile + readDeploymentEnvFile round-trip ───
  describe('write/read round-trip', () => {
    const projectRootUri = {
      scheme: 'file',
      path: '/project',
    } as vscode.Uri;

    it('writes and reads back deployment data via the registry', async () => {
      installFsMock();

      const vars = {
        fabricItemId: 'item-123',
        rayfinApiUrl: 'https://api.example.com',
        fabricWorkspaceId: 'ws-456',
        publishableKey: 'pk_test',
        fabricPortalUrl: 'https://portal.fabric.microsoft.com',
      };

      await writeDeploymentEnvFile(projectRootUri, 'My Workspace', vars);

      const result = await readDeploymentEnvFile(
        projectRootUri,
        'My Workspace'
      );

      expect(result).not.toBeNull();
      expect(result!.fabricItemId).toBe('item-123');
      expect(result!.fabricApiUrl).toBe('https://api.example.com');
      expect(result!.fabricWorkspaceId).toBe('ws-456');
      expect(result!.publishableKey).toBe('pk_test');
      expect(result!.fabricDeepLink).toBe(
        'https://portal.fabric.microsoft.com/groups/ws-456/appbackends/item-123'
      );
    });

    it('mirrors RAYFIN_PUBLIC_* into rayfin/.env', async () => {
      const store = installFsMock();

      await writeDeploymentEnvFile(projectRootUri, 'My Workspace', {
        fabricItemId: 'item-123',
        rayfinApiUrl: 'https://api.example.com',
        fabricWorkspaceId: 'ws-456',
      });

      // Find the entry in the mocked FS that ends with `.env` (not `.deployments.json`).
      const envEntry = Array.from(store.entries()).find(([key]) =>
        key.endsWith('/.env')
      );
      expect(envEntry, '.env file must be written').toBeDefined();
      const envText = new TextDecoder().decode(envEntry![1]);
      expect(envText).toContain(
        'RAYFIN_PUBLIC_API_URL=https://api.example.com'
      );
      expect(envText).toContain('RAYFIN_PUBLIC_ITEM_ID=item-123');
      expect(envText).toContain('RAYFIN_PUBLIC_WORKSPACE_ID=ws-456');
    });

    it('returns null when the registry is empty', async () => {
      installFsMock();
      const result = await readDeploymentEnvFile(projectRootUri, 'missing');
      expect(result).toBeNull();
    });
  });

  // ── findExistingEnvFabricFiles / readLatestDeployment ───────────
  describe('registry enumeration', () => {
    const projectRootUri = {
      scheme: 'file',
      path: '/project',
    } as vscode.Uri;

    it('lists every deployment from the registry', async () => {
      installFsMock();

      await writeDeploymentEnvFile(projectRootUri, 'Alpha', {
        fabricItemId: 'i1',
        rayfinApiUrl: 'u1',
        fabricWorkspaceId: 'w1',
      });
      await writeDeploymentEnvFile(projectRootUri, 'Beta Two', {
        fabricItemId: 'i2',
        rayfinApiUrl: 'u2',
        fabricWorkspaceId: 'w2',
      });

      const files = await findExistingEnvFabricFiles(projectRootUri);
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.workspaceName).sort()).toEqual([
        'alpha',
        'beta-two',
      ]);
    });

    it('returns empty list for missing registry', async () => {
      installFsMock();
      const files = await findExistingEnvFabricFiles(projectRootUri);
      expect(files).toHaveLength(0);
    });

    it('readLatestDeployment returns the active deployment', async () => {
      installFsMock();
      await writeDeploymentEnvFile(projectRootUri, 'Alpha', {
        fabricItemId: 'i1',
        rayfinApiUrl: 'u1',
        fabricWorkspaceId: 'w1',
      });
      await writeDeploymentEnvFile(projectRootUri, 'Beta', {
        fabricItemId: 'i2',
        rayfinApiUrl: 'u2',
        fabricWorkspaceId: 'w2',
      });

      const latest = await readLatestDeployment(projectRootUri);
      expect(latest).not.toBeNull();
      // Last-written is active
      expect(latest!.deployment.fabricItemId).toBe('i2');
    });
  });
});
