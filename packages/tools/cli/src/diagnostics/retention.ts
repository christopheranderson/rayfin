import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DiagnosticRetentionLimits {
  maxAgeMs: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_DIAGNOSTIC_LIMITS: DiagnosticRetentionLimits = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1_000,
  maxFiles: 20,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
};

const DIAGNOSTIC_FILE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z-[a-z0-9-]+-[0-9a-f-]{36}\.log$/;

interface RetainedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Remove only recognized diagnostic logs until a new invocation can fit. */
export async function pruneDiagnosticLogs(
  logDir: string,
  limits: DiagnosticRetentionLimits,
  now = Date.now()
): Promise<void> {
  const entries = await readdir(logDir, { withFileTypes: true });
  const files = (
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && DIAGNOSTIC_FILE_PATTERN.test(entry.name)
        )
        .map(async (entry): Promise<RetainedFile | undefined> => {
          const path = join(logDir, entry.name);
          try {
            const metadata = await stat(path);
            return { path, mtimeMs: metadata.mtimeMs, size: metadata.size };
          } catch {
            return undefined;
          }
        })
    )
  )
    .filter((file): file is RetainedFile => file !== undefined)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);

  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const latestAllowedMtime = now - limits.maxAgeMs;
  const targetFiles = Math.max(0, limits.maxFiles - 1);
  const targetBytes = Math.max(0, limits.maxTotalBytes - limits.maxFileBytes);

  for (const file of files) {
    const remainingFiles = files.filter((candidate) => candidate.size >= 0);
    const expired = file.mtimeMs < latestAllowedMtime;
    const overCount = remainingFiles.length > targetFiles;
    const overSize = totalBytes > targetBytes;
    if (!expired && !overCount && !overSize) {
      continue;
    }
    try {
      await rm(file.path);
      totalBytes -= file.size;
      file.size = -1;
    } catch {
      // Retention is best-effort and concurrent sessions may remove the file.
    }
  }
}
