import { existsSync } from 'fs';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';

import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import type { IPersistence } from '@azure/msal-node-extensions';

import { RAYFIN_CONFIG_DIR, TOKEN_CACHE_FILE } from './constants.js';

/** Options for {@link createCachePlugin} */
export interface CachePluginOptions {
  /** Allow plaintext token storage when OS keychain is unavailable. */
  encryptionFallbackEnabled?: boolean;
}

const PLAINTEXT_FALLBACK_ERROR = `OS keychain is not available and plaintext token storage is not enabled.
To allow plaintext token storage, either:
  • Pass --encryption-fallback-enabled on the login, dev, or up command
  • Set the environment variable RAYFIN_ENCRYPTION_FALLBACK_ENABLED=true`;

/**
 * Creates an MSAL cache plugin that persists tokens to disk with
 * platform-appropriate encryption:
 *
 * - Windows: DPAPI
 * - macOS: Keychain
 * - Linux: libsecret
 *
 * Plaintext fallback is **not** used unless explicitly opted in via
 * the {@link CachePluginOptions.encryptionFallbackEnabled} parameter
 * or the `RAYFIN_ENCRYPTION_FALLBACK_ENABLED` environment variable.
 */
export async function createCachePlugin(
  options?: CachePluginOptions
): Promise<ICachePlugin> {
  const fallbackEnabled =
    options?.encryptionFallbackEnabled === true ||
    process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED']?.toLowerCase() === 'true';
  try {
    await mkdir(RAYFIN_CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(
      `Cannot create auth directory "${RAYFIN_CONFIG_DIR}": ${(err as Error).message}`
    );
  }

  const cachePath = join(RAYFIN_CONFIG_DIR, TOKEN_CACHE_FILE);

  // If the cache file already exists the user previously consented to
  // plaintext storage (via --encryption-fallback-enabled or
  // RAYFIN_ENCRYPTION_FALLBACK_ENABLED). Allow silent reads/writes without
  // requiring the flag again — the file's presence is the consent record.
  const cacheFileExists = existsSync(cachePath);

  // In containers there is no keychain daemon, so skip the native
  // persistence attempt entirely.
  if (isRunningInContainer()) {
    if (!fallbackEnabled && !cacheFileExists) {
      throw new Error(PLAINTEXT_FALLBACK_ERROR);
    }
    if (fallbackEnabled) {
      console.warn(
        '⚠️  OS keychain unavailable; token cache will be stored as plaintext.'
      );
    }
    const persistence = await createPlaintextPersistence(cachePath);
    return new PlaintextCachePlugin(persistence);
  }

  try {
    // Dynamic import: @azure/msal-node-extensions eagerly loads native
    // bindings (keytar / libsecret) at module-evaluation time, so a
    // static import would crash before createCachePlugin's try-catch
    // can fire on systems missing libsecret.
    const { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } =
      await import('@azure/msal-node-extensions');

    const persistence = await PersistenceCreator.createPersistence({
      cachePath,
      dataProtectionScope: DataProtectionScope.CurrentUser,
      serviceName: 'rayfin-cli',
      accountName: 'rayfin-token-cache',
      usePlaintextFileOnLinux: false,
    });

    // PersistenceCachePlugin guards cache access with a sibling
    // `<cachePath>.lockfile`. An interrupted login (Ctrl-C, crash) orphans
    // it, making later commands retry ~50s before failing with
    // CrossPlatformLockError — so reap stale locks up front.
    const lockFilePath = `${cachePath}.lockfile`;
    await reapStaleLockfile(lockFilePath);

    return wrapWithFriendlyLockError(
      new PersistenceCachePlugin(wrapWithResilientLoad(persistence)),
      lockFilePath
    );
  } catch {
    // libsecret or keychain not available
    if (!fallbackEnabled && !cacheFileExists) {
      throw new Error(PLAINTEXT_FALLBACK_ERROR);
    }
    if (fallbackEnabled) {
      console.warn(
        '⚠️  OS keychain unavailable; token cache will be stored as plaintext.'
      );
    }
    const persistence = await createPlaintextPersistence(cachePath);
    return new PlaintextCachePlugin(persistence);
  }
}

/**
 * Minimal plaintext file persistence that reads/writes/deletes a cache
 * file on disk without any native encryption.
 */
interface PlaintextPersistence {
  save(contents: string): Promise<void>;
  load(): Promise<string | null>;
  delete(): Promise<boolean>;
}

async function createPlaintextPersistence(
  cachePath: string
): Promise<PlaintextPersistence> {
  return {
    async save(contents: string): Promise<void> {
      await writeFile(cachePath, contents, { encoding: 'utf8', mode: 0o600 });
    },
    async load(): Promise<string | null> {
      try {
        return await readFile(cachePath, 'utf8');
      } catch {
        return null;
      }
    },
    async delete(): Promise<boolean> {
      try {
        await unlink(cachePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Lightweight ICachePlugin backed by plaintext file persistence.
 * Used as a fallback when \@azure/msal-node-extensions cannot be loaded
 * (e.g. missing libsecret on Linux).
 *
 * Self-heals from an unreadable `cache.bin` (e.g. an encrypted DPAPI /
 * Keychain blob left over from a prior run on the encrypted persistence
 * path) by discarding it once and continuing with an empty cache. Mirrors
 * {@link wrapWithResilientLoad} for the encrypted path so neither code
 * path can lock the user out of `login` / `logout` / `up` / `status`.
 */
class PlaintextCachePlugin implements ICachePlugin {
  private discardedUnreadableCache = false;

  constructor(private readonly persistence: PlaintextPersistence) {}

  async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
    if (this.discardedUnreadableCache) {
      return;
    }
    const data = await this.persistence.load();
    if (!data) {
      return;
    }
    try {
      context.tokenCache.deserialize(data);
    } catch (err) {
      // The on-disk cache.bin is not valid JSON — most commonly because
      // it was previously written by the encrypted persistence path
      // (DPAPI / Keychain / libsecret) and the CLI has since fallen
      // back to plaintext (e.g. keychain init failed, profile changed,
      // or the user is now running in a container). Discard the
      // corrupt file once so the command can proceed with an empty
      // cache instead of crashing every login/logout/up/status
      // invocation with a SyntaxError.
      this.discardedUnreadableCache = true;
      console.warn(
        `⚠️  Token cache could not be parsed (${(err as Error).message}). Discarding the cached credentials; you may be prompted to sign in again.`
      );
      try {
        await this.persistence.delete();
      } catch {
        // Best-effort cleanup. If delete() also fails the next
        // command will warn again, which is acceptable.
      }
    }
  }

  async afterCacheAccess(context: TokenCacheContext): Promise<void> {
    if (context.cacheHasChanged) {
      await this.persistence.save(context.tokenCache.serialize());
      this.discardedUnreadableCache = false;
    }
  }
}

/**
 * Detects common container environments (Docker, Podman, dev containers,
 * GitHub Codespaces, etc.) where a keychain daemon is typically absent.
 */
function isRunningInContainer(): boolean {
  return (
    process.env['REMOTE_CONTAINERS'] !== undefined ||
    process.env['CODESPACES'] !== undefined ||
    process.env['DEVCONTAINER'] !== undefined ||
    existsSync('/.dockerenv') ||
    existsSync('/run/.containerenv')
  );
}

/**
 * Recovers from an unreadable encrypted cache by discarding it once and
 * letting MSAL continue with an empty cache. Save failures still surface.
 */
function wrapWithResilientLoad(inner: IPersistence): IPersistence {
  let discardedUnreadableCache = false;

  return {
    save: async (contents) => {
      await inner.save(contents);
      discardedUnreadableCache = false;
    },
    load: async () => {
      if (discardedUnreadableCache) {
        return null;
      }

      try {
        return await inner.load();
      } catch (err) {
        // Treat an undecryptable cache as no cache: warn, delete the
        // unreadable file via the persistence layer (so any associated
        // keychain entry is cleaned up too), and return null. MSAL
        // then proceeds with an empty cache and either re-prompts for
        // sign-in (login) or treats the user as already signed out
        // (logout / status).
        discardedUnreadableCache = true;
        console.warn(
          `⚠️  Token cache could not be read (${(err as Error).message}). Discarding the cached credentials; you may be prompted to sign in again.`
        );
        try {
          await inner.delete();
        } catch {
          // Best-effort cleanup. If delete() also fails the next
          // load() will warn again, which is acceptable.
        }
        return null;
      }
    },
    delete: async () => {
      const deleted = await inner.delete();
      discardedUnreadableCache = true;
      return deleted;
    },
    reloadNecessary: (lastSync) => inner.reloadNecessary(lastSync),
    getFilePath: () => inner.getFilePath(),
    getLogger: () => inner.getLogger(),
    verifyPersistence: () => inner.verifyPersistence(),
    createForPersistenceValidation: () =>
      inner.createForPersistenceValidation(),
  };
}

/**
 * Returns `true` if a process with the given PID is currently running.
 * Signal `0` only performs an existence/permission check; an `EPERM`
 * result means the process exists but is owned by another user.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

/**
 * Removes an orphaned token-cache lockfile left by an interrupted sign-in.
 *
 * PersistenceCachePlugin writes its PID into the lockfile and deletes it
 * on release. If the file remains but its PID is dead (or unparseable,
 * e.g. a crash before the PID was written), the lock leaked and is
 * removed. A live PID means a sign-in is genuinely in progress, so the
 * lockfile is left untouched.
 */
async function reapStaleLockfile(lockFilePath: string): Promise<void> {
  let pidText: string;
  try {
    pidText = await readFile(lockFilePath, 'utf8');
  } catch {
    // No lockfile (common case) or unreadable — nothing to do.
    return;
  }

  const ownerPid = Number.parseInt(pidText.trim(), 10);
  if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
    return;
  }

  try {
    await unlink(lockFilePath);
    console.warn(
      '⚠️  Removed a stale token-cache lock left by an interrupted sign-in.'
    );
  } catch {
    // Best-effort: a racing unlink is non-fatal since the lock still retries.
  }
}

/**
 * Returns `true` when `err` is the `CrossPlatformLockError` raised by
 * `@azure/msal-node-extensions` when it cannot acquire the cache lock.
 */
function isCrossPlatformLockError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const candidate = err as { errorCode?: string; message?: string };
  return (
    candidate.errorCode === 'CrossPlatformLockError' ||
    (typeof candidate.message === 'string' &&
      candidate.message.includes('CrossPlatformLockError'))
  );
}

/**
 * Wraps an {@link ICachePlugin} so a `CrossPlatformLockError` is rethrown
 * with an actionable message naming the lockfile, instead of MSAL's opaque
 * "Not able to acquire lock" text.
 */
function wrapWithFriendlyLockError(
  plugin: ICachePlugin,
  lockFilePath: string
): ICachePlugin {
  const translate = (err: unknown): never => {
    if (isCrossPlatformLockError(err)) {
      throw new Error(
        `Could not acquire the token-cache lock (${lockFilePath}).\n` +
          'A previous sign-in may not have exited cleanly. Remove the stale ' +
          'lock file and try again:\n' +
          `  rm "${lockFilePath}"`
      );
    }
    throw err;
  };

  return {
    beforeCacheAccess: async (context) => {
      try {
        await plugin.beforeCacheAccess(context);
      } catch (err) {
        translate(err);
      }
    },
    afterCacheAccess: async (context) => {
      try {
        await plugin.afterCacheAccess(context);
      } catch (err) {
        translate(err);
      }
    },
  };
}
