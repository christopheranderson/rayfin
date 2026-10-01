import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyStorageConfigToServer } from '../../utils/storage-apply.js';
import { generateStorageConfig } from '../../utils/storage-config-generator.js';
import { createCliStorageService } from '../storage.js';

vi.mock('../../utils/storage-apply.js', () => ({
  applyStorageConfigToServer: vi.fn(),
}));
vi.mock('../../utils/storage-config-generator.js', () => ({
  generateStorageConfig: vi.fn(),
}));

describe('createCliStorageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('suppresses utility status output and forwards diagnostics', async () => {
    vi.mocked(generateStorageConfig).mockResolvedValue({
      configPath: '/project/rayfin/.temp/storage-config.json',
      folders: [
        {
          name: 'documents',
          displayName: 'Documents',
          onConflict: 'error',
          rules: [],
        },
      ],
      duration: 1,
    });
    const diagnostics = { debug: vi.fn() };
    const service = createCliStorageService({
      diagnostics,
    });

    await service.applyStorageConfig({
      projectRoot: '/project',
      force: true,
      target: {
        itemId: 'item',
        itemEndpoint: 'https://api/item',
        baasEndpoint: 'https://baas/item',
        authorizationHeader: '******',
      },
    });

    expect(generateStorageConfig).toHaveBeenCalledWith({
      projectRoot: '/project',
      mode: 'silent',
      diagnostics,
    });
    expect(applyStorageConfigToServer).toHaveBeenCalledWith(
      '/project/rayfin/.temp/storage-config.json',
      'https://api/item/__private/applystorageconfig',
      true,
      true,
      '******',
      { mode: 'silent', diagnostics }
    );
  });
});
