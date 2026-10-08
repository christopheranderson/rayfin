import { describe, expect, it, vi } from 'vitest';

import {
  StorageApplyError,
  type StorageService,
} from '../../../../services/storage/index.js';
import { applyStorageConfig } from '../apply-storage-config.js';

const target = {
  itemId: 'item',
  itemEndpoint: 'https://api/item',
  baasEndpoint: 'https://baas/item',
  authorizationHeader: 'Bearer token',
};

function storageService(error: Error): StorageService {
  return {
    applyStorageConfig: vi.fn().mockRejectedValue(error),
  };
}

describe('applyStorageConfig', () => {
  it('keeps an HTTP 409 removal block fatal without parsing its message', async () => {
    const error = new StorageApplyError(
      'The manifest could not be applied.',
      409,
      'removal-blocked'
    );

    await expect(
      applyStorageConfig(
        { target, projectRoot: '/project' },
        { storage: storageService(error) }
      )
    ).rejects.toBe(error);
  });

  it('returns an ordinary apply failure as nonfatal', async () => {
    const error = new StorageApplyError(
      'workload unavailable',
      503,
      'request-failed'
    );
    const result = await applyStorageConfig(
      { target, projectRoot: '/project' },
      { storage: storageService(error) }
    );

    expect(result).toEqual({
      status: 'failed-nonfatal',
      message: 'workload unavailable',
    });
  });
});
