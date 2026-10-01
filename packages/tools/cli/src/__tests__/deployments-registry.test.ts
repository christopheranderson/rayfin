import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentRecord } from '../utils/deployments-registry';
import {
  getActiveDeployment,
  getDeployment,
  getDeploymentState,
  isDeployedRecord,
  listDeployments,
  listDeploymentsState,
  readDeploymentsRegistryState,
  setActiveDeployment,
  upsertDeployment,
  upsertDeploymentState,
} from '../utils/deployments-registry';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const BASE_RECORD: DeploymentRecord = {
  itemId: 'item-123',
  itemName: 'My App',
  apiUrl: 'https://example.com/endpoint',
  workspaceId: 'ws-456',
  tenantId: 'tenant-789',
  publishableKey: 'pk-test',
  portalUrl: 'https://app.fabric.microsoft.com',
};

/** Read the raw `.deployments.json` so we can assert on stored fields. */
function readRaw(projectRoot: string): {
  active?: string;
  deployments: Record<string, { fabricDeepLink?: string }>;
} {
  const path = join(projectRoot, 'rayfin', '.deployments.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('deployments-registry deep link composition', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = join(
      tmpdir(),
      `rayfin-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(projectRoot, { recursive: true });
    vi.mocked(readFileSync).mockClear();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('stores a canonical deep link including the ctid suffix', () => {
    upsertDeployment(projectRoot, 'My Workspace', BASE_RECORD);
    const raw = readRaw(projectRoot);
    const key = Object.keys(raw.deployments)[0];
    expect(raw.deployments[key].fabricDeepLink).toBe(
      'https://app.fabric.microsoft.com/groups/ws-456/appbackends/item-123?ctid=tenant-789'
    );
  });

  it('omits the ctid suffix when no tenantId is recorded', () => {
    upsertDeployment(projectRoot, 'My Workspace', {
      ...BASE_RECORD,
      tenantId: undefined,
    });
    const raw = readRaw(projectRoot);
    const key = Object.keys(raw.deployments)[0];
    expect(raw.deployments[key].fabricDeepLink).toBe(
      'https://app.fabric.microsoft.com/groups/ws-456/appbackends/item-123'
    );
  });

  it('leaves the deep link undefined when portalUrl is missing', () => {
    upsertDeployment(projectRoot, 'My Workspace', {
      ...BASE_RECORD,
      portalUrl: undefined,
    });
    const raw = readRaw(projectRoot);
    const key = Object.keys(raw.deployments)[0];
    expect(raw.deployments[key].fabricDeepLink).toBeUndefined();
  });

  it('round-trips the portalUrl back out via getDeployment', () => {
    upsertDeployment(projectRoot, 'My Workspace', BASE_RECORD);
    const record = getDeployment(projectRoot, 'My Workspace');
    expect(record).not.toBeNull();
    expect(record?.portalUrl).toBe('https://app.fabric.microsoft.com');
    expect(record?.itemId).toBe('item-123');
    expect(record?.itemName).toBe('My App');
    expect(record?.workspaceId).toBe('ws-456');
  });

  it('tracks the active deployment and lists deployments', () => {
    upsertDeployment(projectRoot, 'Alpha', BASE_RECORD);
    upsertDeployment(projectRoot, 'Beta', {
      ...BASE_RECORD,
      itemId: 'item-999',
    });

    const active = getActiveDeployment(projectRoot);
    expect(active?.workspaceName).toBe('beta');

    expect(setActiveDeployment(projectRoot, 'Alpha')).toBe(true);
    expect(getActiveDeployment(projectRoot)?.workspaceName).toBe('alpha');

    const all = listDeployments(projectRoot);
    expect(all.map((d) => d.workspaceName).sort()).toEqual(['alpha', 'beta']);
    expect(all.find((d) => d.workspaceName === 'alpha')?.active).toBe(true);
  });

  it('returns false when activating an unknown workspace', () => {
    expect(setActiveDeployment(projectRoot, 'does-not-exist')).toBe(false);
  });

  it('excludes scaffolded context from listings until an item is deployed', () => {
    upsertDeployment(projectRoot, 'Scaffolded', {
      ...BASE_RECORD,
      itemId: '',
      apiUrl: '',
    });

    expect(listDeployments(projectRoot)).toEqual([]);
    expect(listDeploymentsState(projectRoot).deployments).toEqual([]);
    expect(getActiveDeployment(projectRoot)?.record).toMatchObject({
      workspaceId: BASE_RECORD.workspaceId,
      tenantId: BASE_RECORD.tenantId,
      itemId: '',
    });

    upsertDeployment(projectRoot, 'Deployed', BASE_RECORD);
    expect(
      listDeployments(projectRoot).map(({ workspaceName }) => workspaceName)
    ).toEqual(['deployed']);

    upsertDeployment(projectRoot, 'Scaffolded', BASE_RECORD);
    expect(
      listDeployments(projectRoot).map(({ workspaceName }) => workspaceName)
    ).toEqual(['scaffolded', 'deployed']);
  });

  describe('output-free state APIs', () => {
    it('returns a structured warning for a malformed registry', () => {
      const registryPath = join(projectRoot, 'rayfin', '.deployments.json');
      mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
      writeFileSync(registryPath, 'not json');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = readDeploymentsRegistryState(projectRoot);

      expect(result.registry).toEqual({ deployments: {} });
      expect(result.warnings).toEqual([
        expect.stringContaining(`Could not parse ${registryPath}`),
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns a deployment record without rendering warnings', () => {
      upsertDeploymentState(projectRoot, 'My Workspace', BASE_RECORD);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = getDeploymentState(projectRoot, 'My Workspace');

      expect(result).toMatchObject({
        record: {
          itemId: 'item-123',
          workspaceId: 'ws-456',
          portalUrl: 'https://app.fabric.microsoft.com',
        },
        warnings: [],
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('reads the registry once when listing multiple deployments', () => {
      upsertDeploymentState(projectRoot, 'Alpha', BASE_RECORD);
      upsertDeploymentState(projectRoot, 'Beta', {
        ...BASE_RECORD,
        itemId: 'item-999',
      });
      vi.mocked(readFileSync).mockClear();

      const result = listDeploymentsState(projectRoot);

      expect(
        result.deployments.map(({ workspaceName }) => workspaceName)
      ).toEqual(['alpha', 'beta']);
      expect(result.warnings).toEqual([]);
      expect(readFileSync).toHaveBeenCalledOnce();
    });

    it('preserves a malformed-registry warning when upserting', () => {
      const registryPath = join(projectRoot, 'rayfin', '.deployments.json');
      mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
      writeFileSync(registryPath, 'not json');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = upsertDeploymentState(
        projectRoot,
        'My Workspace',
        BASE_RECORD
      );

      expect(result.workspaceKey).toBe('my-workspace');
      expect(result.warnings).toEqual([
        expect.stringContaining(`Could not parse ${registryPath}`),
      ]);
      expect(readRaw(projectRoot).deployments).toHaveProperty('my-workspace');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('isDeployedRecord', () => {
    it('accepts a record carrying both an item and an endpoint', () => {
      expect(isDeployedRecord(BASE_RECORD)).toBe(true);
    });

    it.each([
      // What `rayfin init --workspace-id` pre-seeds before any deploy.
      ['workspace-only pre-seed', { itemId: '', apiUrl: '' }],
      ['item without an endpoint', { itemId: 'item-123', apiUrl: '' }],
      ['endpoint without an item', { itemId: '', apiUrl: 'https://x' }],
    ])('rejects a %s', (_label, record) => {
      expect(isDeployedRecord(record)).toBe(false);
    });

    it('rejects a missing record', () => {
      expect(isDeployedRecord(undefined)).toBe(false);
    });
  });
});
