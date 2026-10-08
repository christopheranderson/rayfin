import { join } from 'path';

import type { DeploymentRecord } from '@microsoft/rayfin-tools-common/_internal/services/deployment-registry';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/deployments-registry.js', () => ({
  getDeployment: vi.fn(),
  getDeploymentState: vi.fn(),
  getActiveDeployment: vi.fn(),
  listDeploymentsState: vi.fn(),
  setActiveDeployment: vi.fn(),
  deploymentToPublicEnv: vi.fn(),
}));

vi.mock('../../utils/env-fabric-utils.js', () => ({
  persistDeploymentEnvFile: vi.fn(),
}));

vi.mock('../../utils/env-file-utils.js', () => ({
  replaceDeploymentEnvInFile: vi.fn(),
}));

import {
  deploymentToPublicEnv,
  getActiveDeployment,
  getDeployment,
  getDeploymentState,
  listDeploymentsState,
  setActiveDeployment,
} from '../../utils/deployments-registry.js';
import { persistDeploymentEnvFile } from '../../utils/env-fabric-utils.js';
import { replaceDeploymentEnvInFile } from '../../utils/env-file-utils.js';
import { createCliDeploymentRegistryService } from '../deployment-registry.js';

const mockGet = getDeployment as ReturnType<typeof vi.fn>;
const mockGetState = getDeploymentState as ReturnType<typeof vi.fn>;
const mockGetActive = getActiveDeployment as ReturnType<typeof vi.fn>;
const mockListState = listDeploymentsState as ReturnType<typeof vi.fn>;
const mockSetActive = setActiveDeployment as ReturnType<typeof vi.fn>;
const mockPersist = persistDeploymentEnvFile as ReturnType<typeof vi.fn>;
const mockToPublicEnv = deploymentToPublicEnv as ReturnType<typeof vi.fn>;
const mockReplaceEnv = replaceDeploymentEnvInFile as ReturnType<typeof vi.fn>;

const record: DeploymentRecord = {
  itemId: 'item-1',
  itemName: 'My App',
  apiUrl: 'https://api.test/workload',
  workspaceId: 'ws-1',
  tenantId: 'tenant-1',
  publishableKey: 'pk-1',
  portalUrl: 'https://app.fabric.test',
  hostingUrl: 'https://app.test',
};

describe('createCliDeploymentRegistryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persistDeployment maps the record onto DeploymentEnvVars and delegates', async () => {
    mockPersist.mockResolvedValue({
      path: '/p/rayfin/.deployments.json',
      workspaceKey: 'my-ws',
      backup: {
        sourcePath: '/p/rayfin/.env',
        backupPath: '/p/rayfin/.env.bak',
      },
    });

    const result = await createCliDeploymentRegistryService().persistDeployment(
      '/p',
      'My WS',
      record
    );

    expect(mockPersist).toHaveBeenCalledWith('/p', 'My WS', {
      rayfinItemId: 'item-1',
      rayfinItemName: 'My App',
      rayfinApiUrl: 'https://api.test/workload',
      fabricWorkspaceId: 'ws-1',
      fabricTenantId: 'tenant-1',
      publishableKey: 'pk-1',
      fabricPortalUrl: 'https://app.fabric.test',
      hostingUrl: 'https://app.test',
    });
    expect(result).toEqual({
      workspaceKey: 'my-ws',
      warnings: [],
      envBackup: {
        sourcePath: '/p/rayfin/.env',
        backupPath: '/p/rayfin/.env.bak',
      },
    });
  });

  it('persistDeployment does not forward deployedAt (host stamps the timestamp)', async () => {
    mockPersist.mockResolvedValue({
      path: '/p/rayfin/.deployments.json',
      workspaceKey: 'my-ws',
    });

    // The contract type omits `deployedAt`; cast to exercise the runtime drop
    // in case an untyped caller smuggles one in.
    await createCliDeploymentRegistryService().persistDeployment(
      '/p',
      'My WS',
      {
        ...record,
        deployedAt: '2024-01-01T00:00:00Z',
      } as Omit<DeploymentRecord, 'deployedAt'>
    );

    const [, , envVars] = mockPersist.mock.calls[0];
    expect(envVars).not.toHaveProperty('deployedAt');
  });

  it('readDeployment delegates to the registry getter', async () => {
    mockGetState.mockReturnValue({ record, warnings: [] });

    const result = await createCliDeploymentRegistryService().readDeployment(
      '/p',
      'My WS'
    );

    expect(mockGetState).toHaveBeenCalledWith('/p', 'My WS');
    expect(result).toEqual({ record, warnings: [] });
  });

  it('getActiveDeployment delegates to the registry', async () => {
    const active = { workspaceName: 'my-ws', record };
    mockGetActive.mockReturnValue(active);

    const result =
      await createCliDeploymentRegistryService().getActiveDeployment('/p');

    expect(mockGetActive).toHaveBeenCalledWith('/p');
    expect(result).toBe(active);
  });

  it('listDeployments delegates to the registry', async () => {
    const entries = [{ workspaceName: 'my-ws', record, active: true }];
    mockListState.mockReturnValue({ deployments: entries, warnings: [] });

    const result =
      await createCliDeploymentRegistryService().listDeployments('/p');

    expect(mockListState).toHaveBeenCalledWith('/p');
    expect(result).toEqual({ deployments: entries, warnings: [] });
  });

  it('setActiveDeployment refreshes the .env mirror on success', async () => {
    mockSetActive.mockReturnValue(true);
    mockGet.mockReturnValue(record);
    const publicEnv = new Map([['RAYFIN_PUBLIC_API_URL', record.apiUrl]]);
    mockToPublicEnv.mockReturnValue(publicEnv);

    const result =
      await createCliDeploymentRegistryService().setActiveDeployment(
        '/p',
        'My WS'
      );

    expect(result).toBe(true);
    expect(mockSetActive).toHaveBeenCalledWith('/p', 'My WS');
    expect(mockGet).toHaveBeenCalledWith('/p', 'My WS');
    expect(mockReplaceEnv).toHaveBeenCalledWith(
      join('/p', 'rayfin'),
      publicEnv
    );
  });

  it('setActiveDeployment does not touch .env when the workspace is absent', async () => {
    mockSetActive.mockReturnValue(false);

    const result =
      await createCliDeploymentRegistryService().setActiveDeployment(
        '/p',
        'Nope'
      );

    expect(result).toBe(false);
    expect(mockReplaceEnv).not.toHaveBeenCalled();
  });

  it('setActiveDeployment returns true without refreshing .env when the record is not re-readable', async () => {
    mockSetActive.mockReturnValue(true);
    mockGet.mockReturnValue(null);

    const result =
      await createCliDeploymentRegistryService().setActiveDeployment(
        '/p',
        'My WS'
      );

    expect(result).toBe(true);
    expect(mockReplaceEnv).not.toHaveBeenCalled();
  });

  it('surfaces a synchronous registry throw as a rejection (catchable via .catch)', async () => {
    // The sync registry util can throw (e.g. an unreadable file). The async
    // body must convert that into a rejection, not a throw at the call site.
    mockGetState.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const service = createCliDeploymentRegistryService();
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = service.readDeployment('/p', 'My WS');
    }).not.toThrow();
    await expect(returned).rejects.toThrow('EACCES');
  });
});
