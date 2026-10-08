import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyStorageConfigToServer: vi.fn(),
  generateStorageConfig: vi.fn(),
  loadRayfinConfig: vi.fn(),
  modeError: vi.fn(),
}));

vi.mock('../utils/config-utils.js', () => ({
  loadRayfinConfig: mocks.loadRayfinConfig,
}));

vi.mock('../utils/output-mode.js', () => ({
  modeLog: vi.fn(),
  modeError: mocks.modeError,
  resolveOutputMode: vi.fn(() => 'interactive'),
}));

vi.mock('../utils/remote-endpoint-utils.js', () => ({
  getRemoteEndpoint: vi.fn(),
  getRemoteAuthorizationHeader: vi.fn(),
  getRemoteStorageConfigUrl: vi.fn(),
  hasRemoteEndpoint: vi.fn(() => false),
}));

vi.mock('../utils/storage-apply.js', () => ({
  applyStorageConfigToServer: mocks.applyStorageConfigToServer,
}));

vi.mock('../utils/storage-config-generator.js', () => ({
  generateStorageConfig: mocks.generateStorageConfig,
}));

vi.mock('../utils/storage-config-utils.js', () => ({
  getStorageConfig: vi.fn(() => ({ provider: 'Local' })),
  StorageProviderType: { OneLake: 'OneLake' },
}));

import { applyStorageConfig } from '../utils/apply-storage-config.js';

describe('applyStorageConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadRayfinConfig.mockReturnValue({
      services: {
        data: { enabled: true },
        storage: { enabled: true },
      },
    });
    mocks.generateStorageConfig.mockResolvedValue({
      configPath: 'storage-config.json',
      folders: [{ name: 'documents' }],
    });
  });

  it('does not append the internal feature hint to a 404 error', async () => {
    mocks.applyStorageConfigToServer.mockRejectedValueOnce(
      new Error(
        'Storage apply endpoint not found (404).\n💡 Upgrade the Rayfin webservice.'
      )
    );

    await applyStorageConfig();

    const output = mocks.modeError.mock.calls.flat().join('\n');
    expect(output).toContain('Storage apply endpoint not found (404)');
    expect(output).not.toContain('Feature 178b');
  });

  it('rejects storage before generation when data is disabled', async () => {
    mocks.loadRayfinConfig.mockReturnValueOnce({
      services: {
        data: { enabled: false },
        storage: { enabled: false },
      },
    });

    await expect(applyStorageConfig({ exitOnError: true })).rejects.toThrow(
      'Storage requires the Data service.'
    );

    expect(mocks.generateStorageConfig).not.toHaveBeenCalled();
    expect(mocks.modeError).toHaveBeenCalledWith(
      'interactive',
      '   Enable services.data or disable services.storage in rayfin.yml.'
    );
  });
});
