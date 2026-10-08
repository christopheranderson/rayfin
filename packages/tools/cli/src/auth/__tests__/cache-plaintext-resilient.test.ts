import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs and fs/promises before importing the module under test. The
// individual readFile / unlink / writeFile mocks are reconfigured per
// test so the plaintext persistence layer reads back whatever payload
// the scenario needs.
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Force the plaintext fallback path by making the native extensions
// module unavailable, the same way the existing cache.test.ts does.
vi.mock('@azure/msal-node-extensions', () => {
  throw new Error('Native module not available');
});

describe('PlaintextCachePlugin — resilient deserialize', () => {
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

  it('discards an unparseable cache file (e.g. leftover DPAPI blob) without throwing', async () => {
    // Simulate cache.bin existing on disk with binary content that is
    // not valid JSON — exactly the screenshot scenario where MSAL's
    // TokenCache.deserialize hands the bytes to JSON.parse and throws.
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith('cache.bin')
    );
    const { readFile, unlink } = await import('fs/promises');
    vi.mocked(readFile).mockResolvedValue(
      '\u0001\u0000\u0000K\u0000\u0000\u0000binary-garbage'
    );

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    const deserialize = vi.fn(() => {
      throw new SyntaxError(
        `Unexpected token '\u0001', "\u0001\u0000\u0000K"... is not valid JSON`
      );
    });

    await expect(
      plugin.beforeCacheAccess({
        tokenCache: { deserialize },
      } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0])
    ).resolves.toBeUndefined();

    // We attempted to deserialize the bytes we read off disk.
    expect(deserialize).toHaveBeenCalledTimes(1);
    // The corrupt file was removed via the persistence layer.
    expect(unlink).toHaveBeenCalledTimes(1);
    // Exactly one user-visible warning explaining why they're being
    // prompted to sign in again.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Token cache');
  });

  it('does not re-read or re-warn on subsequent calls after discarding', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith('cache.bin')
    );
    const { readFile, unlink } = await import('fs/promises');
    vi.mocked(readFile).mockResolvedValue('not-json');

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    const deserialize = vi.fn(() => {
      throw new SyntaxError('Unexpected token n in JSON at position 0');
    });
    const ctx = {
      tokenCache: { deserialize },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0];

    await plugin.beforeCacheAccess(ctx);
    await plugin.beforeCacheAccess(ctx);
    await plugin.beforeCacheAccess(ctx);

    // Only the first call should have actually attempted to read /
    // deserialize / delete. The guard short-circuits the rest.
    expect(deserialize).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no cache file on disk', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith('cache.bin')
    );
    const { readFile, unlink } = await import('fs/promises');
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    const deserialize = vi.fn();
    await plugin.beforeCacheAccess({
      tokenCache: { deserialize },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]);

    expect(deserialize).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('deserializes normally and does not warn when the cache is valid JSON', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith('cache.bin')
    );
    const { readFile, unlink } = await import('fs/promises');
    vi.mocked(readFile).mockResolvedValue('{"Account":{}}');

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    const deserialize = vi.fn();
    await plugin.beforeCacheAccess({
      tokenCache: { deserialize },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]);

    expect(deserialize).toHaveBeenCalledWith('{"Account":{}}');
    expect(unlink).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('survives even if the cleanup unlink also fails', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith('cache.bin')
    );
    const { readFile, unlink } = await import('fs/promises');
    vi.mocked(readFile).mockResolvedValue('garbage');
    vi.mocked(unlink).mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' })
    );

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    const deserialize = vi.fn(() => {
      throw new SyntaxError('not json');
    });

    // The whole point of the wrapper is that the command never crashes
    // because of an unreadable / unremovable cache file.
    await expect(
      plugin.beforeCacheAccess({
        tokenCache: { deserialize },
      } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0])
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('resumes loading after a fresh save replaces the unreadable cache', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith('cache.bin')
    );
    const { readFile, writeFile } = await import('fs/promises');
    vi.mocked(readFile)
      .mockResolvedValueOnce('binary-garbage')
      .mockResolvedValueOnce('{"Account":{}}');

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    // First call: corrupt cache → discarded.
    const firstDeserialize = vi.fn(() => {
      throw new SyntaxError('not json');
    });
    await plugin.beforeCacheAccess({
      tokenCache: { deserialize: firstDeserialize },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]);

    // A successful save (e.g. immediately after a fresh sign-in)
    // should re-arm the plugin so the next load is honored again.
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => '{"fresh":true}' },
    } as unknown as Parameters<typeof plugin.afterCacheAccess>[0]);

    expect(writeFile).toHaveBeenCalledTimes(1);

    // Second call: cache is valid JSON now and must be deserialized.
    const secondDeserialize = vi.fn();
    await plugin.beforeCacheAccess({
      tokenCache: { deserialize: secondDeserialize },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]);

    expect(secondDeserialize).toHaveBeenCalledWith('{"Account":{}}');
    // Still only the original warning — the recovery path is silent.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
