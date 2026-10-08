/**
 * Template registry discovery utilities.
 *
 * Locates template-registries.yml files for display in --list-templates
 * and the interactive picker.
 *
 * Registry sources are merged in tier order (bundled -\> global -\> project).
 * Default/first-class entries (from bundled tier) are protected from override.
 * Name conflicts across non-default registries produce warnings.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadRegistries,
  type RegistryEntry,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import {
  isAbbreviatedCommitShaRef,
  isBranchSentinel,
  isDashPrefixed,
  isFullCommitShaRef,
  isQualifiedBranchRef,
  isValidShortRefName,
} from '@microsoft/rayfin-tools-common/_internal/templates/git';

import { getPackageVersion } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REGISTRY_FILENAME = 'template-registries.yml';

/** Result from registry discovery - entries plus any load/merge warnings. */
export interface RegistryDiscoveryResult {
  entries: RegistryEntry[];
  warnings: string[];
}

type RegistryTier = 'bundled' | 'global' | 'project';

interface RegistryCandidate {
  path: string;
  tier: RegistryTier;
}

/**
 * Decide whether a bundled-registry entry's `ref` is acceptable.
 *
 * Bundled entries ship inside the CLI release, so the ref author is the CLI
 * maintainer rather than the end user. The gate exists to refuse refs that
 * are obviously mutable branch heads - those would let a CLI release scaffold
 * different output on different days, breaking the per-release reproducibility
 * covenant. Tags (including major-floating tags like `v1` that move forward
 * with each `v1.x.y` release) are accepted: the registry author owns the
 * tag-stability covenant with consumers.
 *
 * Accepted shapes:
 *   - 40-char commit SHAs (immutable)
 *   - Any tag-shaped ref (`v1`, `v1.2.3`, `1.0.0`, `release-2024-01`, `lts`)
 *   - Fully-qualified `refs/tags/<X>` where `<X>` is itself a valid short ref
 *     name (non-empty, non-dash-prefixed, not abbreviated-SHA-shaped). The
 *     fetcher normalizes `refs/tags/<X>` to `<X>` before
 *     `git clone --branch`; see `stripQualifiedRefPrefix`.
 *
 * Rejected shapes:
 *   - Empty / undefined
 *   - Abbreviated SHAs (7-39 hex chars) - ambiguous; matches `parseGitUrl`
 *   - Dash-prefixed refs - could be parsed as a git flag; matches `parseGitUrl`
 *   - Known branch sentinels: `HEAD`, `FETCH_HEAD`, `main`, `master`,
 *     `develop`, `trunk` (case-insensitive)
 *   - `refs/heads/<X>` - explicit branch form
 *   - Qualified tag refs whose tail fails the short-ref-name shape check
 *     (e.g. `refs/tags/`, `refs/tags/-rf`, `refs/tags/568c87f`) - mirrors
 *     the unqualified-form guards so the qualified form cannot bypass them.
 *
 * Implementation: all shape predicates live in `templates/git/ref-shapes.ts`
 * in the common package so the same rules apply at every boundary
 * (`parseGitUrl`, `stripQualifiedRefPrefix`, and this gate).
 */
export function isPinnedBundledRegistryRef(ref: string | undefined): boolean {
  if (!ref) {
    return false;
  }
  if (isFullCommitShaRef(ref)) {
    return true;
  }
  if (isAbbreviatedCommitShaRef(ref)) {
    return false;
  }
  if (isDashPrefixed(ref)) {
    return false;
  }
  if (isQualifiedBranchRef(ref)) {
    return false;
  }
  if (isBranchSentinel(ref)) {
    return false;
  }
  // Qualified tag form: re-apply the short-ref-name gate to the tail. This
  // closes the qualified-form bypass: `refs/tags/-rf` and `refs/tags/568c87f`
  // are rejected just as their unqualified equivalents are.
  if (ref.startsWith('refs/tags/')) {
    return isValidShortRefName(ref.slice('refs/tags/'.length));
  }
  return true;
}

/** Validate the stable ref and every optional channel ref on a bundled entry. */
export function hasPinnedBundledRegistryRefs(
  entry: Pick<
    RegistryEntry,
    'ref' | 'alphaRef' | 'betaRef' | 'malformedRefFields'
  >
): boolean {
  if (entry.malformedRefFields && entry.malformedRefFields.length > 0) {
    return false;
  }
  return (
    isPinnedBundledRegistryRef(entry.ref) &&
    [entry.alphaRef, entry.betaRef].every(
      (ref) => ref === undefined || isPinnedBundledRegistryRef(ref)
    )
  );
}

/**
 * Resolve the registry ref for the running CLI release channel.
 *
 * Alpha and beta versions use their matching optional override. Stable
 * versions, unrecognized prerelease channels, and malformed versions use the
 * stable/default `ref`. Missing channel overrides also fall back to `ref` -
 * as does an explicitly empty-string override, which would otherwise bypass
 * the fallback (`??` only treats `null`/`undefined` as absent) and produce
 * an unpinned clone (empty ref fragment) instead.
 */
export function registryRefForCliVersion(
  entry: Pick<RegistryEntry, 'ref' | 'alphaRef' | 'betaRef'>,
  cliVersion: string
): string | undefined {
  const prerelease = cliVersion.match(
    /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)(?:\+[0-9A-Za-z.-]+)?$/
  )?.[1];
  const channel = prerelease?.split('.')[0]?.toLowerCase();

  if (channel === 'alpha') {
    return entry.alphaRef || entry.ref;
  }
  if (channel === 'beta') {
    return entry.betaRef || entry.ref;
  }
  return entry.ref;
}

/**
 * Collect candidate registry file paths in tier order:
 * 1. CLI-bundled:   `<packageRoot>/assets/template-registries.yml` (always loaded)
 * 2. User-global:   `~/.rayfin/template-registries.yml`
 * 3. Project-local: `<configDir>/.rayfin/template-registries.yml`
 */
function candidateRegistryPaths(configDir: string): RegistryCandidate[] {
  const candidates: RegistryCandidate[] = [];

  const packageRoot = resolve(__dirname, '../..');
  candidates.push({
    path: join(packageRoot, 'assets', REGISTRY_FILENAME),
    tier: 'bundled',
  });

  const globalPath = join(homedir(), '.rayfin', REGISTRY_FILENAME);
  if (existsSync(globalPath)) {
    candidates.push({ path: globalPath, tier: 'global' });
  }

  const localPath = join(configDir, '.rayfin', REGISTRY_FILENAME);
  if (existsSync(localPath)) {
    candidates.push({ path: localPath, tier: 'project' });
  }

  return candidates;
}

/**
 * Load and merge registry entries from all available sources.
 *
 * Merge rules (per spec):
 * - Bundled entries with `default: true` or `firstClass: true` are protected
 *   and cannot be overridden
 * - The `default` and `firstClass` flags are ignored in non-bundled registry files
 * - Name conflicts between non-default registries produce a warning
 * - Bundled templates (non-default) can be overridden by global/project entries
 */
export async function discoverRegistryEntries(
  configDir?: string,
  cliVersion = getPackageVersion()
): Promise<RegistryDiscoveryResult> {
  const candidates = candidateRegistryPaths(configDir ?? process.cwd());
  const warnings: string[] = [];

  // Protected names from bundled default/first-class entries
  const protectedNames = new Set<string>();
  // Map of name -> { entry, source } for conflict detection
  const entryMap = new Map<string, { entry: RegistryEntry; source: string }>();

  for (const { path: p, tier } of candidates) {
    const result = await loadRegistries(p);
    warnings.push(...result.warnings);

    const isBundled = tier === 'bundled';

    for (const entry of result.registries) {
      // In bundled tier, honor `default`/`firstClass`; ignore in other tiers.
      const isDefault = isBundled && entry.default === true;
      const isFirstClass = isBundled && entry.firstClass === true;
      if ((isDefault || isFirstClass) && !hasPinnedBundledRegistryRefs(entry)) {
        warnings.push(
          `Registry '${p}': entry '${entry.name}' is protected but contains a missing or unpinned ref - skipped. ` +
            `The stable ref and every configured channel ref must use a 40-character commit SHA or a tag-shaped ref ` +
            `(e.g. 'v1', 'v1.2.3', '1.0.0', 'release-2024-01', 'refs/tags/<tag>'); ` +
            `branch sentinels (main, master, HEAD, refs/heads/*) and abbreviated SHAs are rejected.`
        );
        continue;
      }

      if (isDefault || isFirstClass) {
        protectedNames.add(entry.name);
      }

      // Check for conflicts
      if (entryMap.has(entry.name)) {
        const existing = entryMap.get(entry.name)!;

        // Protected entries cannot be overridden
        if (protectedNames.has(entry.name)) {
          warnings.push(
            `Registry '${p}': entry '${entry.name}' conflicts with ` +
              `protected entry from '${existing.source}' - skipped. ` +
              `Protected entries cannot be overridden.`
          );
          continue;
        }

        // Two non-default entries with same name is a conflict
        warnings.push(
          `Template name '${entry.name}' is defined in both ` +
            `'${existing.source}' and '${p}'. ` +
            `Rename one of the entries to resolve the conflict.`
        );
        continue;
      }

      // Tag entry with its source registry and resolved default flag
      const tagged: RegistryEntry = {
        ...entry,
        ref: registryRefForCliVersion(entry, cliVersion),
        default: isBundled ? entry.default === true : false,
        firstClass: isFirstClass,
        registrySource: isBundled ? 'bundled' : p,
      };
      entryMap.set(entry.name, { entry: tagged, source: p });
    }
  }

  return {
    entries: [...entryMap.values()].map((v) => v.entry),
    warnings,
  };
}
