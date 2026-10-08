/**
 * @packageDocumentation Resolve the `package-lock.json` content to ship in a
 * `rayfin up functions deploy` zip.
 *
 * Policy:
 *  1. If `rayfin/functions/package-lock.json` exists on disk, read and
 *     return it verbatim.  This preserves the developer's "build locally,
 *     deploy the same versions remotely" guarantee.
 *  2. If absent, attempt to generate one by running
 *     `npm install --package-lock-only` against the on-disk
 *     `package.json` in an isolated scratch directory.  No `node_modules/`
 *     is materialized; only the lockfile is captured.  The developer's
 *     working tree is never modified.
 *  3. If `npm` is unavailable (offline, npm not installed, transient
 *     network failure), return `'unavailable'` with a warning so the
 *     caller can decide whether to deploy without a lockfile.
 */

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { spawnSafe } from './platform-utils.js';

export type LockfileSource = 'on-disk' | 'generated' | 'unavailable';

export interface ResolveLockfileOptions {
  /** Optional logger for verbose diagnostics; defaults to a no-op. */
  verbose?: (message: string) => void;
  /**
   * Maximum time `npm install --package-lock-only` is allowed to run before
   * the generation is aborted.  Defaults to 60s.
   */
  timeoutMs?: number;
}

export interface ResolveLockfileResult {
  /**
   * The lockfile content (UTF-8 JSON), or `undefined` when the source is
   * `'unavailable'`.
   */
  lockfileJson?: string;
  /** Where the lockfile came from. */
  source: LockfileSource;
  /** Human-readable warning emitted when source is `'unavailable'`. */
  warning?: string;
}

/**
 * Resolve a deploy-ready `package-lock.json` for the supplied functions
 * folder.  Never mutates the on-disk folder.
 */
export async function resolveDeployLockfile(
  functionsDir: string,
  options: ResolveLockfileOptions = {}
): Promise<ResolveLockfileResult> {
  const verbose = options.verbose ?? (() => {});

  const onDiskPath = join(functionsDir, 'package-lock.json');
  if (existsSync(onDiskPath)) {
    verbose(`using on-disk lockfile: ${onDiskPath}`);
    return {
      lockfileJson: readFileSync(onDiskPath, 'utf8'),
      source: 'on-disk',
    };
  }

  const packageJsonPath = join(functionsDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      source: 'unavailable',
      warning: `package.json not found in ${functionsDir}; cannot generate lockfile`,
    };
  }

  try {
    const lockfileJson = await generateLockfileFromPackageJson(
      functionsDir,
      readFileSync(packageJsonPath, 'utf8'),
      options
    );
    return { lockfileJson, source: 'generated' };
  } catch (err) {
    return {
      source: 'unavailable',
      warning: (err as Error).message,
    };
  }
}

/**
 * Run `npm install --package-lock-only` in an isolated scratch directory
 * populated with the supplied `package.json` (and any `*.tgz` files from
 * `sourceFunctionsDir` so that `file:./*.tgz` deps can resolve without the
 * registry).  Returns the generated lockfile content.  The scratch
 * directory is always cleaned up.
 */
async function generateLockfileFromPackageJson(
  sourceFunctionsDir: string,
  packageJson: string,
  options: ResolveLockfileOptions
): Promise<string> {
  const verbose = options.verbose ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 60_000;

  const scratchDir = mkdtempSync(join(tmpdir(), 'rayfin-lockgen-'));
  verbose(`scratch dir: ${scratchDir}`);

  try {
    writeFileSync(join(scratchDir, 'package.json'), packageJson, 'utf8');

    // Copy any *.tgz files so `file:./*.tgz` deps resolve without registry.
    for (const entry of readdirSync(sourceFunctionsDir, {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith('.tgz')) {
        copyFileSync(
          join(sourceFunctionsDir, entry.name),
          join(scratchDir, entry.name)
        );
        verbose(`copied tarball: ${entry.name}`);
      }
    }

    await runNpmPackageLockOnly(scratchDir, timeoutMs);

    const lockfilePath = join(scratchDir, 'package-lock.json');
    if (!existsSync(lockfilePath)) {
      throw new Error(
        'npm install --package-lock-only completed but did not write package-lock.json'
      );
    }
    return readFileSync(lockfilePath, 'utf8');
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Cleanup failure is non-fatal.
    }
  }
}

function runNpmPackageLockOnly(cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawnSafe(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ],
      { cwd: resolve(cwd), stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectFn(
        new Error(
          `npm install --package-lock-only timed out after ${timeoutMs}ms`
        )
      );
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      rejectFn(
        new Error(`Failed to run npm install: ${err.message}`, { cause: err })
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveFn();
      } else {
        rejectFn(
          new Error(
            `npm install --package-lock-only exited with code ${code}` +
              (stderr ? `\n${stderr.trim()}` : '')
          )
        );
      }
    });
  });
}
