import { HttpError } from '@microsoft/rayfin-tools-common/_internal/utils/retry';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../utils/apply-db-config.js', () => ({
  applyDbConfig: vi.fn(),
}));
vi.mock('../../utils/config-utils.js', () => ({
  resolveServiceRoot: vi.fn(() => '/proj/data'),
}));

import { applyDbConfig } from '../../utils/apply-db-config.js';
import { resolveServiceRoot } from '../../utils/config-utils.js';
import { createCliDataService } from '../data.js';

const mockApplyDbConfig = applyDbConfig as ReturnType<typeof vi.fn>;
const mockResolveServiceRoot = resolveServiceRoot as ReturnType<typeof vi.fn>;

describe('createCliDataService', () => {
  beforeEach(() => {
    mockApplyDbConfig.mockReset();
    mockApplyDbConfig.mockResolvedValue(undefined);
    mockResolveServiceRoot.mockReset();
    mockResolveServiceRoot.mockReturnValue('/proj/data');
  });

  it('maps a local request and always propagates errors', async () => {
    const service = createCliDataService();

    await service.applyDatabaseConfig({
      projectRoot: '/proj',
      target: 'local',
    });

    expect(mockApplyDbConfig).toHaveBeenCalledTimes(1);
    expect(mockApplyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({ remote: false, propagateError: true })
    );
  });

  it('forwards v2 retry intent to the remote apply', async () => {
    const debug = vi.fn();
    const service = createCliDataService({
      diagnostics: { debug },
      captureOutput: true,
    });

    await service.applyDatabaseConfig({
      projectRoot: '/proj',
      target: 'remote',
      remoteEndpoint: 'https://example.test/workload',
      retryTransientErrors: true,
    });

    expect(mockApplyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        buildOutput: 'capture',
        compileMode: 'silent',
        retryTransientErrors: true,
        retryOptions: expect.objectContaining({
          verbose: expect.any(Function),
        }),
      })
    );
    const request = mockApplyDbConfig.mock.calls[0]?.[0] as {
      retryOptions?: { verbose?: (...args: unknown[]) => void };
    };
    request.retryOptions?.verbose?.('[data-apply] Attempt 1/5');
    expect(debug).toHaveBeenCalledWith({
      area: 'data.retry',
      message: '[data-apply] Attempt 1/5',
    });
  });

  it.each([false, true])(
    'selects capture explicitly, independent of a sink (capture=%s)',
    async (captureOutput) => {
      for (const diagnostics of [undefined, { debug: vi.fn() }]) {
        await createCliDataService({
          diagnostics,
          captureOutput,
        }).applyDatabaseConfig({ projectRoot: '/proj', target: 'local' });
        expect(mockApplyDbConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            buildOutput: captureOutput ? 'capture' : 'on-failure',
            compileMode: captureOutput ? 'silent' : undefined,
          })
        );
      }
    }
  );

  it('preserves a remote default-MSSQL 500 for caller-specific handling', async () => {
    const applyError = new HttpError('internal error', 500);
    mockApplyDbConfig.mockRejectedValueOnce(applyError);
    const service = createCliDataService();

    await expect(
      service.applyDatabaseConfig({
        projectRoot: '/proj',
        target: 'remote',
        remoteEndpoint: 'https://example.test/workload',
      })
    ).rejects.toBe(applyError);
  });

  it('maps a remote request and forwards force, dialect, and endpoint', async () => {
    const service = createCliDataService();

    await service.applyDatabaseConfig({
      projectRoot: '/proj',
      target: 'remote',
      force: true,
      dialect: 'postgresql',
      remoteEndpoint: 'https://example.test/workload',
    });

    expect(mockApplyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: true,
        force: true,
        dialect: 'postgresql',
        remoteEndpoint: 'https://example.test/workload',
        propagateError: true,
      })
    );
  });

  it('forwards a pre-resolved authorization header so auth is not reacquired', async () => {
    const service = createCliDataService();

    await service.applyDatabaseConfig({
      projectRoot: '/proj',
      target: 'remote',
      remoteEndpoint: 'https://example.test/workload',
      authorizationHeader: 'Bearer resolved-token',
      itemId: 'item-7',
    });

    expect(mockApplyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: true,
        authorizationHeader: 'Bearer resolved-token',
        rayfinItemId: 'item-7',
        propagateError: true,
      })
    );
  });

  it('resolves serviceRoot from servicePath and forwards it to the util', async () => {
    const service = createCliDataService();

    await service.applyDatabaseConfig({
      projectRoot: '/proj',
      target: 'remote',
      remoteEndpoint: 'https://example.test/workload',
      servicePath: 'packages/data',
    });

    expect(mockResolveServiceRoot).toHaveBeenCalledWith(
      '/proj',
      'data',
      'packages/data'
    );
    expect(mockApplyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({ serviceRoot: '/proj/data' })
    );
  });

  it('uses the project root when no servicePath is provided', async () => {
    const service = createCliDataService();

    await service.applyDatabaseConfig({
      projectRoot: '/proj',
      target: 'local',
    });

    expect(mockResolveServiceRoot).not.toHaveBeenCalled();
    expect(mockApplyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/proj',
        serviceRoot: '/proj',
      })
    );
  });

  it('rejects when the underlying apply rejects', async () => {
    mockApplyDbConfig.mockRejectedValueOnce(new Error('apply failed'));
    const service = createCliDataService();

    await expect(
      service.applyDatabaseConfig({ projectRoot: '/proj', target: 'local' })
    ).rejects.toThrow('apply failed');
  });

  it('preserves a remote PostgreSQL 500 unchanged', async () => {
    const applyError = new HttpError('postgresql apply failed', 500);
    mockApplyDbConfig.mockRejectedValueOnce(applyError);
    const service = createCliDataService();

    await expect(
      service.applyDatabaseConfig({
        projectRoot: '/proj',
        target: 'remote',
        dialect: 'postgresql',
        remoteEndpoint: 'https://example.test/workload',
      })
    ).rejects.toBe(applyError);
  });

  it('preserves a remote MSSQL non-500 error unchanged', async () => {
    const applyError = new HttpError('service unavailable', 503);
    mockApplyDbConfig.mockRejectedValueOnce(applyError);
    const service = createCliDataService();

    await expect(
      service.applyDatabaseConfig({
        projectRoot: '/proj',
        target: 'remote',
        dialect: 'mssql',
        remoteEndpoint: 'https://example.test/workload',
      })
    ).rejects.toBe(applyError);
  });
});
