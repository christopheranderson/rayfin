/**
 * The exclusion rules the bundled sample templates are copied under.
 *
 * Split out from `bundle-template.mjs` so the rules can be exercised directly:
 * that script resolves fixed repository paths and runs its work on import, which
 * leaves nothing testable behind. What must be provable is that a tree carrying
 * a developer's own state cannot be vendored into the vsix, at any depth.
 *
 * Deliberately mirrors the CLI's
 * `packages/tools/cli/scripts/.templateignore`. Maintaining two copies is how
 * this one drifted: it was transcribed from the CLI's global ignore file and
 * lost `rayfin/.deployments.json` on the way. Sharing one list needs a package
 * common to the CLI and VS Code subspaces, which is its own change.
 */
import { statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

/**
 * Names excluded at every depth, not just the top level.
 *
 * A sample is a working Rush project that people run, so it accumulates state
 * belonging to whoever ran it last: `rayfin up` writes
 * `rayfin/.deployments.json`, `rayfin dev` writes `rayfin/.temp`, and Vite
 * writes `.vite`. All of it is gitignored, so it never appears in `git status`,
 * and the vsix is packaged from a developer's working tree rather than in CI.
 */
export const EXCLUDED = new Set([
  '.rush',
  'rush-logs',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.git',
  '.temp',
  '.tmp',
  '.cache',
  '.vite',
  '.DS_Store',
  // Holds registry credentials once anyone has authenticated against a private
  // feed, and it is gitignored, so it is invisible in `git status` before the
  // vsix is packaged out of a working tree.
  '.npmrc',
  '.templateignore',
  // TypeScript writes `tsconfig.tsbuildinfo`, not `.tsbuildinfo`. Matching is on
  // the exact basename, so the name this list carried before never fired.
  'tsconfig.tsbuildinfo',
  '.deployments.json',
  '.rayfin-copilot.json',
  // A lockfile would defeat the caret ranges written into the bundled
  // package.json: npm honours the lock over the declared range, so a scaffolded
  // app would silently reinstall whichever build was current when the extension
  // was packaged.
  'package-lock.json',
]);

/**
 * Rush's per-project `config/` directory, which is meaningless in a scaffolded
 * app. Excluded only at the root, because `src/config` is ordinary app code.
 */
export const EXCLUDED_AT_ROOT = new Set(['config']);

/**
 * Exact paths, relative to the template root, for the cases a name cannot
 * decide on its own.
 *
 * Flat templates and `rayfin functions init` write both under
 * `rayfin/functions`; the Universal App capability writes them under
 * `packages/functions`. `local.settings.json` holds connection strings and
 * whatever keys the developer ran with, while `deploymentdata.json` holds
 * deployment identifiers. The sample gitignores both, so neither appears in
 * `git status` before a vsix is cut from a working tree.
 *
 * Matching the basename would also drop the seed `local.settings.json` the
 * functions capability ships inside its kit, which is source the scaffolded app
 * needs. Same filename, opposite answers, so the rule has to be a path.
 */
export const EXCLUDED_PATHS = new Set([
  'rayfin/functions/local.settings.json',
  'rayfin/functions/deploymentdata.json',
  'packages/functions/local.settings.json',
  'packages/functions/deploymentdata.json',
]);

/** The rules are written posix-style; Windows hands us the other separator. */
const toPosix = (value) => value.replace(/\\/g, '/');

/** `cpSync` may add an extended-length prefix to Windows filter paths. */
const normalizeCopyPath = (value) => {
  if (process.platform !== 'win32') return value;
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
};

/**
 * Whether a directory entry is kept out of the bundled template.
 *
 * `.env`, `.env.local`, and `.env.fabric-<name>` all hold values belonging to
 * whoever last ran the sample, so every `.env*` file is excluded wherever it
 * appears.
 *
 * `relativePath` is the entry's path from the template root. Callers that omit
 * it get name-only matching, which cannot enforce `EXCLUDED_PATHS`.
 */
export function isExcluded(name, atRoot = false, relativePath = undefined) {
  if (EXCLUDED.has(name)) return true;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (relativePath !== undefined && EXCLUDED_PATHS.has(toPosix(relativePath))) {
    return true;
  }
  return atRoot && EXCLUDED_AT_ROOT.has(name);
}

/**
 * The `cpSync` filter the sample template is copied under.
 *
 * Built here rather than written inline in the bundler so the predicate that
 * actually ships can be exercised. A test that reconstructs the filter proves
 * only that the test agrees with itself; in particular it cannot catch the
 * bundler forgetting to pass the relative path, which is the difference between
 * `EXCLUDED_PATHS` being enforced and being decorative.
 *
 * The root `package.json` is dropped because the bundler rewrites it
 * separately. Nested workspace manifests must remain available for their own
 * dependency normalization.
 */
export function createTemplateFilter(src) {
  const sourcePath = normalizeCopyPath(src);

  return (candidate) => {
    const candidatePath = normalizeCopyPath(candidate);
    if (candidatePath === sourcePath) return true;
    const name = basename(candidatePath);
    if (
      candidatePath === join(sourcePath, 'package.json') &&
      !statSync(candidatePath).isDirectory()
    ) {
      return false;
    }
    return !isExcluded(
      name,
      dirname(candidatePath) === sourcePath,
      relative(sourcePath, candidatePath)
    );
  };
}
