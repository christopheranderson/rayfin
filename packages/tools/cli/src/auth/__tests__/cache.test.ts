import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs and fs/promises before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock msal-node-extensions to simulate native keychain unavailability
vi.mock('@azure/msal-node-extensions', () => {
  throw new Error('Native module not available');
});

describe('createCachePlugin', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    delete process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED'];
    delete process.env['REMOTE_CONTAINERS'];
    delete process.env['CODESPACES'];
    delete process.env['DEVCONTAINER'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('when native persistence is unavailable', () => {
    it('should throw when fallback is not enabled', async () => {
      const { createCachePlugin } = await import('../cache.js');

      await expect(createCachePlugin()).rejects.toThrow(
        'OS keychain is not available and plaintext token storage is not enabled.'
      );
    });

    it('should throw with instructions mentioning --encryption-fallback-enabled', async () => {
      const { createCachePlugin } = await import('../cache.js');

      await expect(createCachePlugin()).rejects.toThrow(
        '--encryption-fallback-enabled'
      );
    });

    it('should throw with instructions mentioning RAYFIN_ENCRYPTION_FALLBACK_ENABLED', async () => {
      const { createCachePlugin } = await import('../cache.js');

      await expect(createCachePlugin()).rejects.toThrow(
        'RAYFIN_ENCRYPTION_FALLBACK_ENABLED'
      );
    });

    it('should return a cache plugin when fallback is enabled via option', async () => {
      const { createCachePlugin } = await import('../cache.js');

      const plugin = await createCachePlugin({
        encryptionFallbackEnabled: true,
      });

      expect(plugin).toBeDefined();
      expect(plugin.beforeCacheAccess).toBeDefined();
      expect(plugin.afterCacheAccess).toBeDefined();
    });

    it('should return a cache plugin when RAYFIN_ENCRYPTION_FALLBACK_ENABLED=true', async () => {
      process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED'] = 'true';
      const { createCachePlugin } = await import('../cache.js');

      const plugin = await createCachePlugin();

      expect(plugin).toBeDefined();
      expect(plugin.beforeCacheAccess).toBeDefined();
    });

    it('should accept RAYFIN_ENCRYPTION_FALLBACK_ENABLED=True (mixed case)', async () => {
      process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED'] = 'True';
      const { createCachePlugin } = await import('../cache.js');

      const plugin = await createCachePlugin();

      expect(plugin).toBeDefined();
    });

    it('should accept RAYFIN_ENCRYPTION_FALLBACK_ENABLED=TRUE (uppercase)', async () => {
      process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED'] = 'TRUE';
      const { createCachePlugin } = await import('../cache.js');

      const plugin = await createCachePlugin();

      expect(plugin).toBeDefined();
    });

    it('should silently succeed when cache file already exists and fallback is not enabled', async () => {
      // Simulate a previously-written plaintext cache (user already consented).
      // Only return true for the cache.bin path so container-detection paths
      // (/.dockerenv, /run/.containerenv) still return false.
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation((p) =>
        String(p).endsWith('cache.bin')
      );

      const { createCachePlugin } = await import('../cache.js');

      const plugin = await createCachePlugin();

      expect(plugin).toBeDefined();
      expect(plugin.beforeCacheAccess).toBeDefined();
      expect(plugin.afterCacheAccess).toBeDefined();
    });
  });

  describe('when running in a container', () => {
    it('should throw when fallback is not enabled', async () => {
      process.env['DEVCONTAINER'] = '1';
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { createCachePlugin } = await import('../cache.js');

      await expect(createCachePlugin()).rejects.toThrow(
        'OS keychain is not available and plaintext token storage is not enabled.'
      );
    });

    it('should return a cache plugin when fallback is enabled via option', async () => {
      process.env['DEVCONTAINER'] = '1';
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { createCachePlugin } = await import('../cache.js');

      const plugin = await createCachePlugin({
        encryptionFallbackEnabled: true,
      });

      expect(plugin).toBeDefined();
    });

    it('should return a cache plugin when fallback is enabled via env var', async () => {
      process.env['CODESPACES'] = '1';
      process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED'] = 'true';
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { createCachePlugin } = await import('../cache.js');

      const plugin = await createCachePlugin();

      expect(plugin).toBeDefined();
    });

    it('should silently succeed when cache file already exists and fallback is not enabled', async () => {
      // Simulate a previously-written plaintext cache (user already consented).
      // DEVCONTAINER triggers the container path; the cache.bin check uses
      // existsSync so we return true only for that specific path.
      process.env['DEVCONTAINER'] = '1';
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation((p) =>
        String(p).endsWith('cache.bin')
      );

      const { createCachePlugin } = await import('../cache.js');

      const plugin = await createCachePlugin();

      expect(plugin).toBeDefined();
      expect(plugin.beforeCacheAccess).toBeDefined();
      expect(plugin.afterCacheAccess).toBeDefined();
    });
  });
});
