import { describe, expect, it, vi } from 'vitest';

import type { RayfinConfig } from '../../../../config/index.js';
import type { WorkloadTarget } from '../../../../external/fabric/index.js';
import type { DataService } from '../../../../services/data/index.js';
import { HttpError } from '../../../../utils/retry/index.js';
import { applyDataConfig } from '../apply-data-config.js';

const target: WorkloadTarget = {
  itemId: 'i1',
  itemEndpoint: 'https://api/i1',
  baasEndpoint: 'https://baas/i1',
  authorizationHeader: 'Bearer t',
};

const dataConfig = {
  enabled: true,
  dialect: 'postgresql',
  path: 'packages/data',
  buildCommand: 'npm run build',
} as unknown as RayfinConfig['services']['data'];

function fakeData(overrides: Partial<DataService> = {}): DataService {
  return {
    applyDatabaseConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('applyDataConfig', () => {
  it('applies to the remote item endpoint with the item moniker and service path', async () => {
    const data = fakeData();

    await expect(
      applyDataConfig(
        { target, dataConfig, force: true, projectRoot: '/proj' },
        { data }
      )
    ).resolves.toBeUndefined();

    expect(data.applyDatabaseConfig).toHaveBeenCalledWith({
      projectRoot: '/proj',
      target: 'remote',
      force: true,
      dialect: 'postgresql',
      remoteEndpoint: 'https://api/i1',
      authorizationHeader: 'Bearer t',
      itemId: 'i1',
      servicePath: 'packages/data',
      buildCommand: 'npm run build',
      retryTransientErrors: true,
    });
  });

  it('adds recovery guidance after a remote MSSQL 500 exhausts retries', async () => {
    const applyError = new HttpError(
      'DAB server responded with error: 500 Internal Server Error\n' +
        '   Details: SQL database provisioning failed\n' +
        '   RootActivityId: activity-123',
      500
    );
    const data = fakeData({
      applyDatabaseConfig: vi.fn().mockRejectedValue(applyError),
    });

    try {
      await applyDataConfig(
        {
          target,
          dataConfig: { ...dataConfig, dialect: 'mssql' },
          projectRoot: '/proj',
        },
        { data }
      );
      expect.fail('Expected applyDataConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(500);
      expect((error as Error).message).toContain(
        'The service returned an internal error after retrying'
      );
      expect((error as Error).message).toContain(
        'Run `rayfin up` again in a few minutes'
      );
      expect((error as Error).message).toContain(
        'workspace-level private links may be the cause'
      );
      expect((error as Error).message).toContain(
        'contact support with the response and any request ID'
      );
      expect((error as Error).message).toContain('activity-123');
      expect((error as Error).cause).toBe(applyError);
    }
  });

  it('preserves a remote PostgreSQL 500 unchanged', async () => {
    const applyError = new HttpError('postgresql apply failed', 500);
    const data = fakeData({
      applyDatabaseConfig: vi.fn().mockRejectedValue(applyError),
    });

    await expect(
      applyDataConfig({ target, dataConfig, projectRoot: '/proj' }, { data })
    ).rejects.toBe(applyError);
  });

  it('preserves a remote MSSQL non-500 error unchanged', async () => {
    const applyError = new HttpError('service unavailable', 503);
    const data = fakeData({
      applyDatabaseConfig: vi.fn().mockRejectedValue(applyError),
    });

    await expect(
      applyDataConfig(
        {
          target,
          dataConfig: { ...dataConfig, dialect: 'mssql' },
          projectRoot: '/proj',
        },
        { data }
      )
    ).rejects.toBe(applyError);
  });

  it('rethrows a generic apply error', async () => {
    const applyError = new Error('TypeScript compilation failed');
    const data = fakeData({
      applyDatabaseConfig: vi.fn().mockRejectedValue(applyError),
    });

    await expect(
      applyDataConfig({ target, dataConfig, projectRoot: '/proj' }, { data })
    ).rejects.toBe(applyError);
  });

  it('rethrows a destructive-change rejection when --force is absent', async () => {
    const destructive = new Error('Destructive schema changes detected');
    const data = fakeData({
      applyDatabaseConfig: vi.fn().mockRejectedValue(destructive),
    });

    await expect(
      applyDataConfig(
        { target, dataConfig, force: false, projectRoot: '/proj' },
        { data }
      )
    ).rejects.toBe(destructive);
  });

  it('rethrows an apply rejection when --force is set', async () => {
    const destructive = new Error('Destructive schema changes detected');
    const data = fakeData({
      applyDatabaseConfig: vi.fn().mockRejectedValue(destructive),
    });

    await expect(
      applyDataConfig(
        { target, dataConfig, force: true, projectRoot: '/proj' },
        { data }
      )
    ).rejects.toBe(destructive);
  });
});
