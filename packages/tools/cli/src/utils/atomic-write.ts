/**
 * Write a file atomically: write to a sibling temp file, then rename into place.
 *
 * `fs.renameSync` is atomic on POSIX and Windows when source and destination are
 * on the same filesystem. The temp file lives next to the target so the rename
 * stays on-volume.
 *
 * Why this matters: callers like the ai-files lockfile and `.mcp.json` writes
 * can be interrupted (SIGINT, power loss, disk full). A partial write leaves
 * the next read consuming garbled JSON, which strict validators surface as a
 * hard error and block recovery.
 */

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  encoding: 'utf8' = 'utf8'
): void {
  const tmpPath = join(
    dirname(filePath),
    `.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    writeFileSync(tmpPath, data, encoding);
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup; if the temp file can't be removed, warn so the
    // user knows there's a stray `.<hex>.tmp` file to clean up by hand.
    try {
      rmSync(tmpPath, { force: true });
    } catch (cleanupErr) {
      console.warn(
        `[rayfin] Failed to clean up temp file ${tmpPath}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
      );
    }
    throw err;
  }
}
