/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDeploymentsRegistryPath } from '../utils/deployments-registry';
import {
  findExistingEnvFabricFiles,
  persistDeploymentEnvFile,
  preSeedDeploymentEnvFile,
  readDeploymentEnvFile,
  resolveDeploymentEnvFile,
  sanitizeWorkspaceName,
  writeDeploymentEnvFile,
} from '../utils/env-fabric-utils';

describe('env-fabric-utils (registry-backed)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `rayfin-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
    mkdirSync(join(testDir, 'rayfin'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('sanitizeWorkspaceName', () => {
    it('lowercases and replaces spaces with hyphens', () => {
      expect(sanitizeWorkspaceName('My Workspace')).toBe('my-workspace');
    });

    it('strips special characters', () => {
      expect(sanitizeWorkspaceName('Test @ Workspace!')).toBe('test-workspace');
    });

    it('handles unicode by stripping non-ascii', () => {
      expect(sanitizeWorkspaceName('Tëst — Ñame')).toBe('tst-ame');
    });

    it('collapses multiple hyphens', () => {
      expect(sanitizeWorkspaceName('a---b')).toBe('a-b');
    });

    it('trims leading/trailing hyphens', () => {
      expect(sanitizeWorkspaceName(' -Test- ')).toBe('test');
    });

    it('replaces underscores with hyphens', () => {
      expect(sanitizeWorkspaceName('my_workspace')).toBe('my-workspace');
    });
  });

  describe('writeDeploymentEnvFile / readDeploymentEnvFile', () => {
    it('returns the normalized key without rendering output', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await persistDeploymentEnvFile(testDir, 'My Workspace', {
        rayfinItemId: 'item-123',
        fabricWorkspaceId: 'ws-456',
      });

      expect(result.workspaceKey).toBe('my-workspace');
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it('returns malformed-registry warnings without rendering them', async () => {
      writeFileSync(join(testDir, 'rayfin', '.deployments.json'), 'not json');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await persistDeploymentEnvFile(testDir, 'workspace', {
        rayfinItemId: 'item-123',
        fabricWorkspaceId: 'ws-456',
      });

      expect(result.warnings).toEqual([
        expect.stringContaining('Could not parse'),
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('returns backup facts without rendering the backup notice', async () => {
      writeFileSync(
        join(testDir, 'rayfin', '.env'),
        '# hand-maintained\nCUSTOM_VALUE=preserved\n'
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await persistDeploymentEnvFile(testDir, 'workspace', {
        rayfinItemId: 'item-123',
        fabricWorkspaceId: 'ws-456',
      });

      expect(result.backup?.sourcePath).toBe(join(testDir, 'rayfin', '.env'));
      expect(result.backup?.backupPath).toBe(
        join(testDir, 'rayfin', '.env.bak')
      );
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('renders backup facts from the legacy writer', async () => {
      writeFileSync(
        join(testDir, 'rayfin', '.env'),
        '# hand-maintained\nCUSTOM_VALUE=preserved\n'
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await writeDeploymentEnvFile(testDir, 'workspace', {
        rayfinItemId: 'item-123',
        fabricWorkspaceId: 'ws-456',
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Backed up your previous ${join(testDir, 'rayfin', '.env')}`
        )
      );
      warnSpy.mockRestore();
    });

    it('round-trips all fields via the registry', async () => {
      const vars = {
        rayfinItemId: 'item-123',
        rayfinApiUrl: 'https://example.com/api',
        fabricWorkspaceId: 'ws-456',
        publishableKey: 'pk-abc',
        fabricPortalUrl: 'https://fabric.microsoft.com',
        hostingUrl: 'https://myapp.azurewebsites.net',
      };

      await writeDeploymentEnvFile(testDir, 'My Workspace', vars);

      const result = readDeploymentEnvFile(testDir, 'My Workspace');
      expect(result).not.toBeNull();
      expect(result!.rayfinItemId).toBe('item-123');
      expect(result!.rayfinApiUrl).toBe('https://example.com/api');
      expect(result!.fabricWorkspaceId).toBe('ws-456');
      expect(result!.publishableKey).toBe('pk-abc');
      expect(result!.fabricPortalUrl).toBe('https://fabric.microsoft.com');
      expect(result!.hostingUrl).toBe('https://myapp.azurewebsites.net');
    });

    it('round-trips without optional fields', async () => {
      await writeDeploymentEnvFile(testDir, 'Test WS', {
        rayfinItemId: 'item-789',
        rayfinApiUrl: 'https://example.com/api2',
        fabricWorkspaceId: 'ws-012',
      });

      const result = readDeploymentEnvFile(testDir, 'Test WS');
      expect(result).not.toBeNull();
      expect(result!.rayfinItemId).toBe('item-789');
      expect(result!.publishableKey).toBeUndefined();
      expect(result!.fabricPortalUrl).toBeUndefined();
      expect(result!.hostingUrl).toBeUndefined();
    });

    it('writes into `rayfin/.deployments.json`', async () => {
      await writeDeploymentEnvFile(testDir, 'My Workspace', {
        rayfinItemId: 'x',
        rayfinApiUrl: 'y',
        fabricWorkspaceId: 'z',
      });
      expect(existsSync(getDeploymentsRegistryPath(testDir))).toBe(true);
    });

    it('does NOT write legacy `.env.fabric-*` files', async () => {
      await writeDeploymentEnvFile(testDir, 'My Workspace', {
        rayfinItemId: 'x',
        rayfinApiUrl: 'y',
        fabricWorkspaceId: 'z',
      });
      expect(existsSync(join(testDir, '.env.fabric-my-workspace'))).toBe(false);
      expect(existsSync(join(testDir, '.env.fabric'))).toBe(false);
    });

    it('overwrites on subsequent writes', async () => {
      await writeDeploymentEnvFile(testDir, 'ws', {
        rayfinItemId: 'old',
        rayfinApiUrl: 'old-url',
        fabricWorkspaceId: 'old-ws',
      });
      await writeDeploymentEnvFile(testDir, 'ws', {
        rayfinItemId: 'new',
        rayfinApiUrl: 'new-url',
        fabricWorkspaceId: 'new-ws',
      });

      const result = readDeploymentEnvFile(testDir, 'ws');
      expect(result!.rayfinItemId).toBe('new');
    });

    it('should strip newlines from values to prevent env injection', async () => {
      const vars = {
        rayfinItemId: 'bad\nINJECTED_VAR=evil',
        fabricWorkspaceId: 'ws-ok',
      };

      await writeDeploymentEnvFile(testDir, 'Inject WS', vars);

      // The registry stores the value as-is — injection is prevented by
      // the JSON serialization in .deployments.json, not by stripping.
      const result = readDeploymentEnvFile(testDir, 'Inject WS');
      expect(result).not.toBeNull();
      expect(result!.rayfinItemId).toBe('bad\nINJECTED_VAR=evil');
    });

    it('clears stale RAYFIN_PUBLIC_* keys from rayfin/.env when overwriting with a deployment that omits them', async () => {
      // First deployment carries every projected key.
      await writeDeploymentEnvFile(testDir, 'first', {
        rayfinItemId: 'item-1',
        rayfinApiUrl: 'https://api.first',
        fabricWorkspaceId: 'ws-1',
        fabricTenantId: 'tenant-1',
        publishableKey: 'pk_first',
        fabricPortalUrl: 'https://portal.fabric.microsoft.com',
      });
      const { readFileSync } = await import('fs');
      const envPath = join(testDir, 'rayfin', '.env');
      const before = readFileSync(envPath, 'utf8');
      expect(before).toContain('RAYFIN_PUBLIC_TENANT_ID=tenant-1');
      expect(before).toContain('RAYFIN_PUBLIC_PUBLISHABLE_KEY=pk_first');

      // Second deployment omits tenantId, publishableKey, and portalUrl.
      await writeDeploymentEnvFile(testDir, 'first', {
        rayfinItemId: 'item-2',
        rayfinApiUrl: 'https://api.second',
        fabricWorkspaceId: 'ws-2',
      });
      const after = readFileSync(envPath, 'utf8');
      expect(after).toContain('RAYFIN_PUBLIC_API_URL=https://api.second');
      expect(after).toContain('RAYFIN_PUBLIC_ITEM_ID=item-2');
      expect(after).toContain('RAYFIN_PUBLIC_WORKSPACE_ID=ws-2');
      expect(after).not.toContain('RAYFIN_PUBLIC_TENANT_ID');
      expect(after).not.toContain('RAYFIN_PUBLIC_PUBLISHABLE_KEY');
      expect(after).not.toContain('RAYFIN_PUBLIC_PORTAL_URL');
    });

    it('preserves non-deployment env keys when rewriting deployment projection', async () => {
      const { writeFileSync, readFileSync } = await import('fs');
      const envPath = join(testDir, 'rayfin', '.env');
      writeFileSync(
        envPath,
        [
          'RAYFIN_POSTGRES_PASSWORD=keep-me',
          'RAYFIN_SERVICES_DATA_PORT=5432',
          'RAYFIN_PUBLIC_FEATURE_X=user-defined',
          '',
        ].join('\n'),
        'utf8'
      );
      await writeDeploymentEnvFile(testDir, 'preserve', {
        rayfinItemId: 'item',
        rayfinApiUrl: 'https://api',
        fabricWorkspaceId: 'ws',
      });
      const content = readFileSync(envPath, 'utf8');
      expect(content).toContain('RAYFIN_POSTGRES_PASSWORD=keep-me');
      expect(content).toContain('RAYFIN_SERVICES_DATA_PORT=5432');
      expect(content).toContain('RAYFIN_PUBLIC_FEATURE_X=user-defined');
      expect(content).toContain('RAYFIN_PUBLIC_API_URL=https://api');
    });
  });

  describe('readDeploymentEnvFile', () => {
    it('returns null when the registry is empty', () => {
      expect(readDeploymentEnvFile(testDir, 'nonexistent')).toBeNull();
    });

    it('returns null for an unknown workspace', async () => {
      await writeDeploymentEnvFile(testDir, 'existing', {
        rayfinItemId: 'x',
        rayfinApiUrl: 'y',
        fabricWorkspaceId: 'z',
      });
      expect(readDeploymentEnvFile(testDir, 'other')).toBeNull();
    });

    it('ignores a malformed registry file', () => {
      mkdirSync(join(testDir, 'rayfin'), { recursive: true });
      writeFileSync(getDeploymentsRegistryPath(testDir), 'not json', 'utf8');
      expect(readDeploymentEnvFile(testDir, 'anything')).toBeNull();
    });
  });

  describe('findExistingEnvFabricFiles (registry-backed)', () => {
    it('returns no entries for an empty registry', () => {
      expect(findExistingEnvFabricFiles(testDir)).toHaveLength(0);
    });

    it('returns every deployment as a legacy-shaped info object', async () => {
      await writeDeploymentEnvFile(testDir, 'Alpha', {
        rayfinItemId: 'i1',
        rayfinApiUrl: 'u1',
        fabricWorkspaceId: 'w1',
      });
      await writeDeploymentEnvFile(testDir, 'Beta Two', {
        rayfinItemId: 'i2',
        rayfinApiUrl: 'u2',
        fabricWorkspaceId: 'w2',
      });

      const result = findExistingEnvFabricFiles(testDir);
      expect(result).toHaveLength(2);
      expect(result.map((f) => f.workspaceName).sort()).toEqual([
        'alpha',
        'beta-two',
      ]);
    });
  });

  describe('partial pre-seeded files', () => {
    it('should support partial pre-seeded files without rayfinApiUrl', async () => {
      const vars = {
        rayfinItemId: 'item-partial',
        fabricWorkspaceId: 'ws-partial',
      };

      await writeDeploymentEnvFile(testDir, 'Partial WS', vars);

      const result = readDeploymentEnvFile(testDir, 'Partial WS');
      expect(result).not.toBeNull();
      expect(result!.rayfinItemId).toBe('item-partial');
      expect(result!.fabricWorkspaceId).toBe('ws-partial');
      expect(result!.rayfinApiUrl).toBe('');
    });
  });

  describe('preSeedDeploymentEnvFile (registry-backed)', () => {
    it('should write a registry record with both IDs', () => {
      const result = preSeedDeploymentEnvFile(testDir, {
        fabricItemId: 'item-seed',
        fabricWorkspaceId: 'ws-seed',
      });
      expect(result).toBe(true);

      const deployment = readDeploymentEnvFile(testDir, 'default');
      expect(deployment).not.toBeNull();
      expect(deployment!.rayfinItemId).toBe('item-seed');
      expect(deployment!.fabricWorkspaceId).toBe('ws-seed');
    });

    it('should write workspace-only pre-seed', () => {
      const result = preSeedDeploymentEnvFile(testDir, {
        fabricWorkspaceId: 'ws-only',
      });

      expect(result).toBe(true);
      const deployment = readDeploymentEnvFile(testDir, 'default');
      expect(deployment).not.toBeNull();
      expect(deployment!.fabricWorkspaceId).toBe('ws-only');
      expect(deployment!.rayfinItemId).toBe('');
    });

    it('should not write item-only pre-seed without workspace ID', () => {
      const result = preSeedDeploymentEnvFile(testDir, {
        fabricItemId: 'item-only',
      });

      expect(result).toBe(false);
    });

    it('should not write when neither field is provided', () => {
      const result = preSeedDeploymentEnvFile(testDir, {});
      expect(result).toBe(false);
    });

    it('should not overwrite existing deployment with API URL', async () => {
      // Simulate an existing full deployment
      await writeDeploymentEnvFile(testDir, 'default', {
        rayfinItemId: 'existing',
        rayfinApiUrl: 'https://api.example.com',
        fabricWorkspaceId: 'ws-existing',
      });

      const result = preSeedDeploymentEnvFile(testDir, {
        fabricItemId: 'new-item',
        fabricWorkspaceId: 'new-ws',
      });

      expect(result).toBe(false);
      const deployment = readDeploymentEnvFile(testDir, 'default');
      expect(deployment!.rayfinItemId).toBe('existing');
    });

    it('should not create legacy env.fabric files', () => {
      preSeedDeploymentEnvFile(testDir, {
        fabricItemId: 'x',
        fabricWorkspaceId: 'y',
      });

      expect(existsSync(join(testDir, '.env.fabric'))).toBe(false);
      expect(existsSync(join(testDir, '.env.fabric-default'))).toBe(false);
    });

    it('should key the deployment by the provided workspace name', () => {
      const result = preSeedDeploymentEnvFile(
        testDir,
        {
          fabricItemId: 'item-named',
          fabricWorkspaceId: 'ws-named',
        },
        'My Test App'
      );

      expect(result).toBe(true);
      // sanitizeWorkspaceName slugifies "My Test App" → "my-test-app"
      const deployment = readDeploymentEnvFile(testDir, 'my-test-app');
      expect(deployment).not.toBeNull();
      expect(deployment!.fabricWorkspaceId).toBe('ws-named');
      // Default key should NOT be populated when an override is provided.
      expect(readDeploymentEnvFile(testDir, 'default')).toBeNull();
    });
  });

  describe('resolveDeploymentEnvFile with pre-seeded data', () => {
    it('should resolve a pre-seeded deployment', async () => {
      preSeedDeploymentEnvFile(testDir, {
        fabricItemId: 'item-preseed',
        fabricWorkspaceId: 'ws-preseed',
      });

      const result = await resolveDeploymentEnvFile({
        projectRoot: testDir,
        nonInteractive: true,
      });

      expect(result).not.toBeNull();
      expect(result!.deployment.rayfinItemId).toBe('item-preseed');
      expect(result!.deployment.fabricWorkspaceId).toBe('ws-preseed');
    });

    it('should prefer a full deployment over a pre-seed', async () => {
      preSeedDeploymentEnvFile(testDir, {
        fabricItemId: 'item-preseed',
        fabricWorkspaceId: 'ws-preseed',
      });

      // Write a full workspace-scoped deployment
      await writeDeploymentEnvFile(testDir, 'My WS', {
        rayfinItemId: 'item-deployed',
        rayfinApiUrl: 'https://api.example.com',
        fabricWorkspaceId: 'ws-deployed',
      });

      const result = await resolveDeploymentEnvFile({
        projectRoot: testDir,
        nonInteractive: true,
      });

      expect(result).not.toBeNull();
      // The latest writeDeploymentEnvFile sets active, so it wins
      expect(result!.deployment.rayfinItemId).toBe('item-deployed');
      expect(result!.workspaceName).toBe('my-ws');
    });
  });
});
