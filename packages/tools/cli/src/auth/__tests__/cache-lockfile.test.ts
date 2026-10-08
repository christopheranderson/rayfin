import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs and fs/promises so RAYFIN_CONFIG_DIR creation succeeds and we
// don't touch the real home directory. `readFile` stands in for the
// lockfile contents reaped by `reapStaleLockfile`, and `unlink` lets us
// assert the stale lockfile was removed.
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

const readFileMock = vi.fn();
const unlinkMock = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: (...args: unknown[]) => unlinkMock(...args),
}));

// Controls what the stubbed PersistenceCachePlugin.beforeCacheAccess does
// so individual tests can simulate a CrossPlatformLockError (or success).
let beforeAccessImpl: () => Promise<void> = async () => undefined;

vi.mock('@azure/msal-node-extensions', () => ({
  DataProtectionScope: { CurrentUser: 'CurrentUser' },
  PersistenceCreator: {
    createPersistence: vi.fn(async () => ({
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
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
    })),
  },
  PersistenceCachePlugin: class {
    async beforeCacheAccess(): Promise<void> {
      return beforeAccessImpl();
    }
    async afterCacheAccess(): Promise<void> {
      return beforeAccessImpl();
    }
  },
}));

/** Build a PersistenceError-shaped lock error like msal-node-extensions. */
function makeLockError(): Error & { errorCode: string } {
  const err = new Error(
    'CrossPlatformLockError: Not able to acquire lock. Exceeded amount of retries set in options'
  ) as Error & { errorCode: string };
  err.name = 'PersistenceError';
  err.errorCode = 'CrossPlatformLockError';
  return err;
}

describe('createCachePlugin — stale lockfile reaping', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    beforeAccessImpl = async () => undefined;
    originalEnv = { ...process.env };
    delete process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED'];
    delete process.env['REMOTE_CONTAINERS'];
    delete process.env['CODESPACES'];
    delete process.env['DEVCONTAINER'];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    killSpy = vi.spyOn(process, 'kill') as unknown as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    process.env = originalEnv;
    warnSpy.mockRestore();
    killSpy.mockRestore();
  });

  it('removes a lockfile whose owning PID is no longer running', async () => {
    readFileMock.mockResolvedValue('424242');
    // process.kill(pid, 0) throwing ESRCH means the process is gone.
    killSpy.mockImplementation(() => {
      const err = new Error('no such process') as Error & { code?: string };
      err.code = 'ESRCH';
      throw err;
    });

    const { createCachePlugin } = await import('../cache.js');
    await createCachePlugin();

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock.mock.calls[0]?.[0]).toMatch(/cache\.bin\.lockfile$/);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('stale token-cache lock');
  });

  it('removes a lockfile with unparseable contents (crashed before writing PID)', async () => {
    readFileMock.mockResolvedValue('');

    const { createCachePlugin } = await import('../cache.js');
    await createCachePlugin();

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock.mock.calls[0]?.[0]).toMatch(/cache\.bin\.lockfile$/);
  });

  it('leaves the lockfile alone when the owning PID is still alive', async () => {
    readFileMock.mockResolvedValue(String(process.pid));
    killSpy.mockImplementation(() => true);

    const { createCachePlugin } = await import('../cache.js');
    await createCachePlugin();

    expect(unlinkMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does nothing when there is no lockfile', async () => {
    readFileMock.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 'ENOENT' })
    );

    const { createCachePlugin } = await import('../cache.js');
    await createCachePlugin();

    expect(unlinkMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('createCachePlugin — friendly CrossPlatformLockError', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    readFileMock.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 'ENOENT' })
    );
    originalEnv = { ...process.env };
    delete process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED'];
    delete process.env['REMOTE_CONTAINERS'];
    delete process.env['CODESPACES'];
    delete process.env['DEVCONTAINER'];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('rethrows a lock error with an actionable message and lockfile path', async () => {
    beforeAccessImpl = async () => {
      throw makeLockError();
    };

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    await expect(
      plugin.beforeCacheAccess(
        {} as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]
      )
    ).rejects.toThrow(/Could not acquire the token-cache lock/);

    await expect(
      plugin.beforeCacheAccess(
        {} as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]
      )
    ).rejects.toThrow(/cache\.bin\.lockfile/);
  });

  it('passes through non-lock errors unchanged', async () => {
    beforeAccessImpl = async () => {
      throw new Error('some other failure');
    };

    const { createCachePlugin } = await import('../cache.js');
    const plugin = await createCachePlugin();

    await expect(
      plugin.beforeCacheAccess(
        {} as unknown as Parameters<typeof plugin.beforeCacheAccess>[0]
      )
    ).rejects.toThrow('some other failure');
  });
});
