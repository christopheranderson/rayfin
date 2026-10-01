import { describe, expect, it, vi } from 'vitest';

import type {
  DeploymentListEntry,
  DeploymentRecord,
  DeploymentRegistryService,
} from '../../../../services/deployment-registry/index.js';
import { persistDeployment } from '../persist-deployment.js';

const record: Omit<DeploymentRecord, 'deployedAt'> = {
  itemId: 'i1',
  apiUrl: 'https://baas/i1',
  workspaceId: 'w1',
  tenantId: 'tenant-new',
};

function fakeRegistry(
  overrides: Partial<DeploymentRegistryService> = {}
): DeploymentRegistryService {
  return {
    persistDeployment: vi
      .fn()
      .mockResolvedValue({ workspaceKey: 'my-workspace', warnings: [] }),
    readDeployment: vi.fn().mockResolvedValue({ record: null, warnings: [] }),
    getActiveDeployment: vi.fn(),
    listDeployments: vi
      .fn()
      .mockResolvedValue({ deployments: [], warnings: [] }),
    setActiveDeployment: vi.fn(),
    ...overrides,
  };
}

const entry = (
  workspaceName: string,
  active: boolean
): DeploymentListEntry => ({
  workspaceName,
  active,
  record: { itemId: 'x', apiUrl: 'y', workspaceId: 'z' },
});

describe('persistDeployment', () => {
  it('persists the record and reports no warnings when clean', async () => {
    const registry = fakeRegistry();

    const result = await persistDeployment(
      { projectRoot: '/p', workspaceName: 'My Workspace', record },
      { registry }
    );

    expect(registry.persistDeployment).toHaveBeenCalledWith(
      '/p',
      'My Workspace',
      record
    );
    expect(result.workspaceKey).toBe('my-workspace');
    expect(result.warnings).toEqual([]);
  });

  it('warns when the prior deployment used a different tenant', async () => {
    const registry = fakeRegistry({
      readDeployment: vi.fn().mockResolvedValue({
        record: {
          itemId: 'i1',
          apiUrl: 'a',
          workspaceId: 'w1',
          tenantId: 'tenant-old',
        },
        warnings: [],
      }),
    });

    const result = await persistDeployment(
      { projectRoot: '/p', workspaceName: 'My Workspace', record },
      { registry }
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('tenant-old');
    expect(result.warnings[0]).toContain('tenant-new');
  });

  it('warns about other registered workspaces, even when they are also active', async () => {
    // Identity-based, not active-flag-based: a second *active* entry must still
    // be reported. The old `!active` filter would have wrongly omitted it.
    const registry = fakeRegistry({
      listDeployments: vi.fn().mockResolvedValue({
        deployments: [
          entry('my-workspace', true),
          entry('Other Workspace', true),
        ],
        warnings: [],
      }),
    });

    const result = await persistDeployment(
      { projectRoot: '/p', workspaceName: 'My Workspace', record },
      { registry }
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Other Workspace');
  });

  it('accumulates both advisories when the tenant differs AND another workspace is registered', async () => {
    const registry = fakeRegistry({
      readDeployment: vi.fn().mockResolvedValue({
        record: {
          itemId: 'i1',
          apiUrl: 'a',
          workspaceId: 'w1',
          tenantId: 'tenant-old',
        },
        warnings: [],
      }),
      listDeployments: vi.fn().mockResolvedValue({
        deployments: [
          entry('my-workspace', true),
          entry('Other Workspace', false),
        ],
        warnings: [],
      }),
    });

    const result = await persistDeployment(
      { projectRoot: '/p', workspaceName: 'My Workspace', record },
      { registry }
    );

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('tenant-old'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Other Workspace'))).toBe(
      true
    );
  });

  it('propagates a rejecting registry write', async () => {
    const registry = fakeRegistry({
      persistDeployment: vi.fn().mockRejectedValue(new Error('write failed')),
    });

    await expect(
      persistDeployment(
        { projectRoot: '/p', workspaceName: 'My Workspace', record },
        { registry }
      )
    ).rejects.toThrow('write failed');
  });

  it('preserves persistence facts when advisory listing fails', async () => {
    const registry = fakeRegistry({
      persistDeployment: vi.fn().mockResolvedValue({
        workspaceKey: 'my-workspace',
        envBackup: {
          sourcePath: '/p/rayfin/.env',
          backupPath: '/p/rayfin/.env.bak',
        },
        warnings: [],
      }),
      listDeployments: vi.fn().mockRejectedValue(new Error('EACCES')),
    });

    const result = await persistDeployment(
      { projectRoot: '/p', workspaceName: 'My Workspace', record },
      { registry }
    );

    expect(result.envBackup?.backupPath).toBe('/p/rayfin/.env.bak');
    expect(result.warnings).toContain(
      'Could not list registered workspace deployments: EACCES'
    );
  });
});
