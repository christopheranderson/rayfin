/**
 * Functions deploy packaging utilities for the Rayfin CLI.
 *
 * Packages a functions source folder into a ZIP for deploy, with support for
 * in-memory path overrides (e.g. transformed dev-mode metadata) and pre-flight
 * file counting. Kept separate from static-hosting packaging because the two
 * deploy APIs enforce independent size limits.
 */

import {
  createWriteStream,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import archiver from 'archiver';

import { formatBytes } from './format-utils.js';

/**
 * Client-side guard on the compressed deploy ZIP size for functions.
 *
 * The deploy backend caps the *entire* multipart request at 300 MB. That
 * request carries the raw (non-base64) ZIP plus a `DeployMetaData` JSON part
 * and a little multipart overhead, so the ZIP itself must stay under ~250 MB
 * to leave ~50 MB of headroom for metadata + overhead.
 *
 * Note: the wired deploy path uses `isCompiledZip: true`, so the ZIP keeps
 * `node_modules/`, `dist/`, and TypeScript sources — it is *not*
 * source-only, so this limit is genuinely reachable for real projects.
 * Packaging streams to a temp file and enforces this cap incrementally, so
 * peak memory does not scale with the archive size. Failing here produces a
 * clear client-side error instead of an opaque server rejection.
 */
export const FUNCTIONS_DEPLOY_ZIP_CLIENT_LIMIT_BYTES = 250 * 1024 * 1024;

/**
 * Prefix for the temporary directories that hold an in-flight deploy ZIP.
 * Shared by the packager (which creates them) and the cleanup sweep (which
 * removes orphans), so the two never drift apart.
 */
const ZIP_TEMP_PREFIX = 'rayfin-fnzip-';

/**
 * Best-effort cleanup of packaging temp dirs orphaned by a prior run that was
 * hard-killed — e.g. the terminal window was closed, the IDE "stop" button was
 * used, or the process was killed via Task Manager. Those paths bypass both the
 * `try/finally` cleanup and the SIGINT/SIGTERM handler (Windows has no real
 * POSIX signals, so an external kill runs no JS), leaving a `rayfin-fnzip-*`
 * dir behind.
 *
 * Only dirs older than `maxAgeMs` are removed, so a *concurrent* deploy's
 * in-flight dir is never disturbed; a locked file (Windows) additionally makes
 * the removal a no-op. Never throws — cleanup must not break a deploy.
 *
 * @param maxAgeMs - Minimum age (by mtime) before an orphan is eligible for
 *                   removal. Defaults to 1 hour, far longer than any real
 *                   package + upload, including retries.
 */
export function cleanStaleZipTempDirs(maxAgeMs = 60 * 60 * 1000): void {
  const root = tmpdir();
  const cutoff = Date.now() - maxAgeMs;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(ZIP_TEMP_PREFIX)) continue;
    const full = join(root, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // In use (locked on Windows), already gone, or racing another sweep —
      // skip it; a later run will catch it if it truly is an orphan.
    }
  }
}

/**
 * Options for {@link packageFolderWithOverrides}.
 */
export interface PackageFolderOptions {
  /**
   * Directory names (matched at any depth) that should be skipped entirely
   * during traversal.  Useful for excluding caches, build outputs, or
   * dev-only assets.  Defaults to an empty set.
   */
  excludeDirNames?: ReadonlySet<string>;
  /**
   * File names (matched at any depth) that should be skipped entirely during
   * traversal.  Useful for excluding local-only or secret files that must
   * never ship (e.g. `local.settings.json`).  Defaults to an empty set.
   */
  excludeFileNames?: ReadonlySet<string>;
  /** Exact file suffixes to exclude at any depth. Defaults to none. */
  excludeFileSuffixes?: readonly string[];
  /**
   * Root-relative file or directory paths to exclude, including descendants.
   * Accepts either path separator; matches whole path segments only.
   * Explicit overrides take precedence over all exclusions.
   */
  excludeRootPaths?: ReadonlySet<string>;
  /**
   * Hard cap on the compressed archive size. Enforced incrementally while
   * archiving, so an over-limit package is aborted before it is fully
   * written. Defaults to {@link FUNCTIONS_DEPLOY_ZIP_CLIENT_LIMIT_BYTES}.
   * Exposed primarily so the incremental-abort path can be exercised in
   * tests without materializing a multi-hundred-megabyte fixture.
   */
  maxCompressedBytes?: number;
}

/**
 * A packaged deploy ZIP written to a temporary file on disk.
 *
 * The ZIP is streamed to disk during packaging and uploaded straight from
 * `zipPath` via `fs.openAsBlob`, so the compressed archive is never held in
 * memory as a contiguous buffer.
 * Callers MUST invoke {@link PackagedZip.cleanup} once the upload completes
 * (or fails) to remove the backing temp directory.
 */
export interface PackagedZip {
  /** Absolute path to the on-disk compressed ZIP, ready to upload. */
  zipPath: string;
  /** Compressed size of the ZIP in bytes. */
  byteLength: number;
  /**
   * Remove the temporary directory backing {@link zipPath}. Best-effort and
   * idempotent — safe to call more than once and from a `finally` block.
   */
  cleanup(): void;
}

type PackageEntry = { archivePath: string } & (
  | { fullPath: string }
  | { content: string | Buffer }
);

function* packageEntries(
  resolvedDir: string,
  options: PackageFolderOptions,
  overrides: Record<string, string | Buffer>
): Generator<PackageEntry> {
  const normalizePath = (path: string): string => path.replace(/\\/g, '/');
  const overrideEntries = new Map(
    Object.entries(overrides).map(([path, content]) => [
      normalizePath(path),
      content,
    ])
  );
  const excludeRootPaths = [...(options.excludeRootPaths ?? [])].map(
    normalizePath
  );

  function* walk(dir: string, prefix: string): Generator<PackageEntry> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        excludeRootPaths.some(
          (path) => archivePath === path || archivePath.startsWith(`${path}/`)
        )
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        if (options.excludeDirNames?.has(entry.name)) continue;
        yield* walk(fullPath, archivePath);
      } else if (entry.isFile()) {
        if (options.excludeFileNames?.has(entry.name)) continue;
        if (
          options.excludeFileSuffixes?.some((suffix) =>
            entry.name.endsWith(suffix)
          )
        ) {
          continue;
        }
        if (overrideEntries.has(archivePath)) continue;
        yield { archivePath, fullPath };
      }
    }
  }

  yield* walk(resolvedDir, '');
  for (const [archivePath, content] of overrideEntries) {
    yield { archivePath, content };
  }
}

/**
 * Package a folder into a ZIP on disk, substituting in-zip contents for the
 * supplied path overrides instead of reading them from disk.  Useful when a
 * file on disk holds dev-mode metadata that must be transformed before
 * deploy without mutating the developer's working tree.
 *
 * The archive is streamed to a temp file and the client-side size cap is
 * enforced incrementally, so an over-limit archive is aborted before it is
 * fully written and the compressed bytes are never buffered contiguously in
 * memory. Rejects if the compressed size exceeds
 * {@link FUNCTIONS_DEPLOY_ZIP_CLIENT_LIMIT_BYTES}.
 *
 * @param resolvedDir - The folder to package.
 * @param overrides - Map of archive path (relative to `resolvedDir`)
 *                      to the bytes to embed at that path.  Files at these
 *                      paths on disk are skipped; entries that have no
 *                      corresponding file on disk are still appended, even
 *                      when excluded. Either path separator is accepted.
 * @param options - Additional packaging options.
 * @returns A {@link PackagedZip} handle whose temp directory the caller must
 *          `cleanup()` after uploading.
 */
export async function packageFolderWithOverrides(
  resolvedDir: string,
  overrides: Record<string, string | Buffer>,
  options: PackageFolderOptions = {}
): Promise<PackagedZip> {
  const maxCompressedBytes =
    options.maxCompressedBytes ?? FUNCTIONS_DEPLOY_ZIP_CLIENT_LIMIT_BYTES;

  // Sweep orphans from prior hard-killed runs before adding our own dir, so
  // interruptions the signal handler can't catch self-heal on the next deploy.
  cleanStaleZipTempDirs();

  const tmpDir = mkdtempSync(join(tmpdir(), ZIP_TEMP_PREFIX));
  const zipPath = join(tmpDir, 'source.zip');
  const cleanup = (): void => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a leftover temp dir is reclaimed by the OS eventually.
    }
  };

  return new Promise<PackagedZip>((resolvePkg, reject) => {
    let byteLength = 0;
    let settled = false;

    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = createWriteStream(zipPath);

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      archive.destroy();
      // Remove the temp dir only after the write stream's fd is actually
      // closed. destroy() closes it asynchronously, so calling cleanup() in
      // the same tick can race the close and fail on Windows (EPERM/EBUSY),
      // orphaning the dir until the next sweep.
      output.once('close', cleanup);
      output.destroy();
      reject(err);
    };

    // Enforce the client-side cap incrementally: abort the moment cumulative
    // compressed bytes cross the limit, so an over-limit archive is never
    // fully materialized on disk or in memory.
    archive.on('data', (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > maxCompressedBytes) {
        fail(
          new Error(
            `Compressed package size exceeded the ${formatBytes(maxCompressedBytes)} limit ` +
              `(aborted at ${formatBytes(byteLength)}). ` +
              'Reduce the number or size of files in your folder.'
          )
        );
      }
    });

    archive.on('error', fail);
    output.on('error', fail);
    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolvePkg({ zipPath, byteLength, cleanup });
    });

    archive.pipe(output);

    // The recursive walk and override append are synchronous and run before
    // finalize(); route any failure (e.g. an unreadable subdir throwing from
    // readdirSync, or a dir removed mid-walk) through fail() so the temp dir
    // and write-stream fd are always released — the same guarantee finalize's
    // .catch(fail) already provides for the async phase.
    try {
      for (const entry of packageEntries(resolvedDir, options, overrides)) {
        if ('fullPath' in entry) {
          archive.file(entry.fullPath, { name: entry.archivePath });
        } else {
          archive.append(entry.content, { name: entry.archivePath });
        }
      }

      archive.finalize().catch(fail);
    } catch (err) {
      fail(err as Error);
    }
  });
}

/**
 * Walk a directory and count the files + total size that would be included
 * by {@link packageFolderWithOverrides} given the same options and overrides.
 * Useful for pre-flight reporting before invoking the packager.
 */
export function countPackageableFiles(
  resolvedDir: string,
  options: PackageFolderOptions = {},
  overrides: Record<string, string | Buffer> = {}
): { fileCount: number; totalSizeBytes: number } {
  let fileCount = 0;
  let totalSizeBytes = 0;

  for (const entry of packageEntries(resolvedDir, options, overrides)) {
    fileCount++;
    totalSizeBytes +=
      'fullPath' in entry
        ? statSync(entry.fullPath).size
        : Buffer.byteLength(entry.content);
  }

  return { fileCount, totalSizeBytes };
}
