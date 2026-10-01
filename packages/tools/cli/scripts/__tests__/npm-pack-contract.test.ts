import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnSyncSafe } from '../../src/utils/platform-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const cliPackageRoot = resolve(__dirname, '..', '..');

interface PackedFile {
  path: string;
}

interface NpmPackEntry {
  files: PackedFile[];
}

/**
 * ADO #2090326 — the project-root `.gitignore` produced by `rayfin init` is
 * sourced from `assets/.gitignore.template`. The `.template` suffix exists
 * because `npm pack` strips literal `.gitignore` files from the published
 * tarball regardless of the package's `files` field. Without the suffix,
 * the canonical writer's source asset wouldn't ship and the original bug
 * would silently re-emerge.
 *
 * This test converts that safety property from "the PR description says so"
 * into a CI guard. Two failure modes it catches:
 *
 * 1. A future "drop the .template suffix" cleanup PR that renames the asset
 *    back to `.gitignore` — npm pack would strip it, the canonical writer
 *    would have nothing to copy, and scaffolded projects would lose their
 *    root `.gitignore`.
 * 2. A bundle-script swap that doesn't go through `npm-packlist` — could
 *    re-introduce nested `.gitignore` files into the published tarball,
 *    breaking the audit invariant.
 */
describe('npm pack contract for @microsoft/rayfin-cli', () => {
  it('ships assets/.gitignore.template AND no literal .gitignore entries', () => {
    // `npm pack --dry-run --json` prints the file list without producing a
    // tarball. Run from the CLI package root.
    // Use spawnSyncSafe so Windows resolves `npm.cmd` via PATHEXT (it
    // engages shell:true only on the `.cmd` branch with per-argument
    // quoting). Plain `child_process.spawnSync('npm', […], { shell: true })`
    // trips Node.js v22+'s DEP0190 deprecation warning on non-Windows
    // hosts where `npm` resolves directly.
    const { stdout: stdoutBuf, status } = spawnSyncSafe(
      'npm',
      ['pack', '--dry-run', '--json'],
      {
        cwd: cliPackageRoot,
        env: { ...process.env, NPM_CONFIG_LOGLEVEL: 'silent' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    expect(status).toBe(0);
    const stdout = String(stdoutBuf ?? '');

    const parsed = JSON.parse(stdout) as NpmPackEntry[];
    expect(parsed.length).toBe(1);
    const filePaths = parsed[0]!.files.map((f) => f.path);

    // The canonical asset must ship — without it, init.ts has nothing to
    // copy and scaffolded projects lose their root .gitignore.
    expect(filePaths).toContain('assets/.gitignore.template');
    expect(filePaths).toContain('templates/universal-app/.gitignore.template');
    expect(filePaths).toContain(
      'templates/universal-app/rayfin/.gitignore.template'
    );

    // No file in the tarball can be a literal `.gitignore` (root or nested).
    // npm strips these by default; a future bundle-script change that
    // bypasses npm-packlist would re-introduce them and silently break
    // either the canonical-writer contract (if at root) or restore the
    // original Sev 2 bug (if nested under templates/).
    const literalGitignores = filePaths.filter(
      (path) => path === '.gitignore' || path.endsWith('/.gitignore')
    );
    expect(literalGitignores).toEqual([]);
  }, 60_000);
});
