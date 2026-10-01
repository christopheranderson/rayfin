/**
 * First-run telemetry notice for the Rayfin CLI.
 *
 * On the very first invocation, prints a notice to stderr explaining
 * that anonymous usage data is collected, and how to opt out. The
 * notice-shown state is persisted to the user's platform config
 * directory so it appears only once.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { RAYFIN_CONFIG_DIR } from '../auth/constants.js';

const NOTICE_FILENAME = 'telemetry-notice-shown';

const NOTICE_TEXT = `
Rayfin tools collect anonymous usage data to improve the product.
No personal data or parameter values are collected.
To opt out, set environment variable: RAYFIN_TELEMETRY_OPTOUT=1
`;

/**
 * Show the first-run telemetry notice if it hasn't been shown yet.
 *
 * Writes a marker file to the config directory so the notice is not
 * repeated on subsequent invocations. All file-system errors are
 * silently ignored — the notice is best-effort.
 */
export function showFirstRunNoticeIfNeeded(): void {
  try {
    const markerPath = join(RAYFIN_CONFIG_DIR, NOTICE_FILENAME);

    if (existsSync(markerPath)) {
      return;
    }

    process.stderr.write(NOTICE_TEXT);

    mkdirSync(RAYFIN_CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(markerPath, new Date().toISOString(), 'utf8');
  } catch {
    // Best-effort: swallow errors silently.
  }
}
