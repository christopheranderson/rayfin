import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs and fs/promises so RAYFIN_CONFIG_DIR creation succeeds and we
// don't actually touch the real home directory during tests.
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  // No token-cache lockfile exists in these tests, so `reapStaleLockfile`
  // finds nothing to remove and the resilient-load assertions below see
  // only the warnings they expect.
  readFile: vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('not found'), { code: 'ENOENT' })
    ),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Build a fake `IPersistence` instance that lets the test control what
 * `load()` does on each call. The other methods are tracked so the test
 * can assert that an unreadable cache was deleted via the persistence
 * layer (not directly via fs.unlink).
 */
function makeFakePersistence(loadImpl: () => Promise<string | null>) {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(loadImpl),
    delete: vi.fn().mockResolvedValue(true),
    reloadNecessary: vi.fn().mockResolvedValue(true),
    getFilePath: vi.fn().mockReturnValue('/tmp/cache.bin'),
    getLogger: vi.fn().mockReturnValue({
      info: () => undefined,
      verbose: () => undefined,
      warning: () => undefined,
      error: () => undefined,
      tracePii: () => undefined,
    }),
    verifyPersistence: vi.fn().mockResolvedValue(true),
    createForPersistenceValidation: vi.fn(),
  };
}

let activePersistence: ReturnType<typeof makeFakePersistence>;

// Provide a working msal-node-extensions stub. The real package eagerly
// loads native bindings, so the wider test suite mocks it to throw. Here
// we want the encrypted-persistence happy path so we can exercise the
// resilient `load()` wrapper.
vi.mock('@azure/msal-node-extensions', () => ({
  DataProtectionScope: { CurrentUser: 'CurrentUser' },
  PersistenceCreator: {
    createPersistence: vi.fn(async () => activePersistence),
  },
  // Minimal PersistenceCachePlugin that mirrors the real one: it just
  // calls persistence.load() in beforeCacheAccess and persistence.save()
  // in afterCacheAccess, with no cross-platform lock. That's enough to
  // exercise the wrapper without needing the native lock implementation.
  PersistenceCachePlugin: class {
    constructor(public persistence: ReturnType<typeof makeFakePersistence>) {}
    async beforeCacheAccess(context: {
      tokenCache: { deserialize: (data: string) => void };
    }): Promise<void> {
      const data = await this.persistence.load();
      if (data) {
        context.tokenCache.deserialize(data);
      }
    }
    async afterCacheAccess(context: {
      cacheHasChanged: boolean;
      tokenCache: { serialize: () => string };
    }): Promise<void> {
      if (context.cacheHasChanged) {
        await this.persistence.save(context.tokenCache.serialize());
      }
    }
  },
}));

describe('createCachePlugin — resilient load (encrypted persistence)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    delete process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED'];
    delete process.env['REMOTE_CONTAINERS'];
    delete process.env['CODESPACES'];
    delete process.env['DEVCONTAINER'];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    warnSpy.mockRestore();
  });

  it('returns null and deletes the cache when load() throws (e.g. Windows DPAPI error 13)', async () => {
    activePersistence = makeFakePersistence(async () => {
      // Mirror the shape of the DPAPI failure surfaced by
      // msal-node-extensions on Windows when an existing cache.bin
      // cannot be decrypted under the current user/profile.
      throw new Error('Encryption/Decryption failed. Error code: 13');
    });

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    const deserialize = vi.fn();
    await plugin.beforeCacheAccess({
      tokenCache: { deserialize },
      // The real TokenCacheContext has more fields, but the plugin only
      // touches `tokenCache` in beforeCacheAccess.
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]);

    expect(activePersistence.load).toHaveBeenCalledTimes(1);
    // The corrupt cache must be cleaned up via the persistence layer so
    // that any associated keychain/DPAPI artifacts are removed too —
    // not just the on-disk file.
    expect(activePersistence.delete).toHaveBeenCalledTimes(1);
    // A null load means MSAL never deserializes any cached state.
    expect(deserialize).not.toHaveBeenCalled();
    // The user gets exactly one warning so they understand why they're
    // being prompted to sign in again.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('Error code: 13');
  });

  it('warns and deletes only once after discarding an unreadable cache', async () => {
    activePersistence = makeFakePersistence(async () => {
      throw new Error('Encryption/Decryption failed. Error code: 13');
    });

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    const context = {
      tokenCache: { deserialize: vi.fn() },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0];

    await plugin.beforeCacheAccess(context);
    await plugin.beforeCacheAccess(context);

    expect(activePersistence.load).toHaveBeenCalledTimes(1);
    expect(activePersistence.delete).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(context.tokenCache.deserialize).not.toHaveBeenCalled();
  });

  it('does not warn or delete when load() succeeds with no cache', async () => {
    activePersistence = makeFakePersistence(async () => null);

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    await plugin.beforeCacheAccess({
      tokenCache: { deserialize: vi.fn() },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]);

    expect(activePersistence.load).toHaveBeenCalledTimes(1);
    expect(activePersistence.delete).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn or delete when load() succeeds with cached data', async () => {
    activePersistence = makeFakePersistence(async () => '{"Account":{}}');

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    const deserialize = vi.fn();
    await plugin.beforeCacheAccess({
      tokenCache: { deserialize },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]);

    expect(activePersistence.load).toHaveBeenCalledTimes(1);
    expect(activePersistence.delete).not.toHaveBeenCalled();
    expect(deserialize).toHaveBeenCalledWith('{"Account":{}}');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('survives even if persistence.delete() also fails during cleanup', async () => {
    activePersistence = makeFakePersistence(async () => {
      throw new Error('Encryption/Decryption failed. Error code: 13');
    });
    activePersistence.delete.mockRejectedValueOnce(
      new Error('cannot unlink locked file')
    );

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    // Must not throw — the whole point of the wrapper is that an
    // unreadable cache never blocks the command.
    await expect(
      plugin.beforeCacheAccess({
        tokenCache: { deserialize: vi.fn() },
      } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0])
    ).resolves.toBeUndefined();
  });

  it('resumes loading after a successful save writes a fresh cache', async () => {
    activePersistence = makeFakePersistence(
      vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Encryption/Decryption failed. Error code: 13')
        )
        .mockResolvedValueOnce('{"Account":{}}')
    );

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    await plugin.beforeCacheAccess({
      tokenCache: { deserialize: vi.fn() },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]);

    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => '{"fresh":true}' },
    } as unknown as Parameters<typeof plugin.afterCacheAccess>[0]);

    const deserialize = vi.fn();
    await plugin.beforeCacheAccess({
      tokenCache: { deserialize },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]);

    expect(activePersistence.save).toHaveBeenCalledWith('{"fresh":true}');
    expect(activePersistence.load).toHaveBeenCalledTimes(2);
    expect(deserialize).toHaveBeenCalledWith('{"Account":{}}');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
