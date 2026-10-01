import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

export interface MergeFilesExcludeResult {
  /** `true` when the file was created or modified. */
  written: boolean;
  /** Absolute path to the target `settings.json`. */
  path: string;
}

/**
 * Non-destructively merge `files.exclude` globs into the **project root's**
 * `.vscode/settings.json`.
 *
 * Follows the same pattern as `mergeLaunchConfig` in `dev-functions.ts`:
 *   - Missing file → create it.
 *   - Strict JSON → add only the keys not already present (a user's explicit
 *     override is never clobbered); every other setting is preserved.
 *   - Not strict JSON (JSONC with comments) → leave untouched and warn; we
 *     have no comment-preserving parser, so we never rewrite.
 *
 * @returns `written: false` when nothing changed (JSONC bail, or every key was
 * already present) so re-running `functions init` is idempotent.
 */
export async function mergeRootFilesExclude(
  projectRoot: string,
  excludes: Record<string, boolean>
): Promise<MergeFilesExcludeResult> {
  const settingsPath = join(projectRoot, '.vscode', 'settings.json');
  const fileExists = existsSync(settingsPath);

  let settings: Record<string, unknown> = {};
  if (fileExists) {
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    } catch {
      console.warn(
        `⚠️  ${settingsPath} is not strict JSON (likely JSONC with comments). ` +
          `Add these "files.exclude" entries manually: ${Object.keys(excludes).join(', ')}.`
      );
      return { written: false, path: settingsPath };
    }
  }

  const exclude = { ...(settings['files.exclude'] as Record<string, boolean>) };
  const before = JSON.stringify(exclude);
  for (const [key, value] of Object.entries(excludes)) {
    if (!(key in exclude)) exclude[key] = value;
  }
  if (fileExists && JSON.stringify(exclude) === before) {
    return { written: false, path: settingsPath };
  }

  settings['files.exclude'] = exclude;
  await mkdir(join(projectRoot, '.vscode'), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + '\n',
    'utf8'
  );
  return { written: true, path: settingsPath };
}
