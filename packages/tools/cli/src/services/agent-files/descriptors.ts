/**
 * Descriptor table for Rayfin-managed agent-files items.
 *
 * Adding a new managed item is a one-line append plus a new bundled asset under
 * `assets/agent-files/`. Manager and strategies are descriptor-driven; no other
 * code changes are required.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCliFeatureFlags } from '../../utils/feature-flags.js';

import { getStrategy } from './strategies/index.js';
import { sha256Hex } from './strategies/strategy.js';
import type { Descriptor } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root of the bundled assets directory inside the published CLI package. */
const ASSETS_ROOT = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'assets',
  'agent-files'
);

/**
 * Managed items shipped by this CLI version.
 *
 * Generally available descriptors ship unconditionally. Preview descriptors
 * use the same feature resolver as their matching CLI surface.
 *
 * @param projectRoot - Directory used to resolve project configuration and
 *   feature flags.
 */
export function getRayfinDescriptors(
  projectRoot: string
): readonly Descriptor[] {
  const featureFlags = createCliFeatureFlags(projectRoot, { silent: true });

  return [
    {
      kind: 'skill',
      name: 'rayfin',
      bundledAsset: 'skills/rayfin/SKILL.md',
    },
    {
      kind: 'skill',
      name: 'rayfin-functions',
      bundledAsset: 'skills/rayfin-functions/SKILL.md',
    },
    {
      kind: 'skill',
      name: 'rayfin-connectors',
      bundledAsset: 'skills/rayfin-connectors/SKILL.md',
    },
    ...(featureFlags.get('storage') === true
      ? [
          {
            kind: 'skill' as const,
            name: 'rayfin-storage',
            bundledAsset: 'skills/rayfin-storage/SKILL.md',
          },
        ]
      : []),
    {
      kind: 'mcp',
      name: 'rayfin',
      bundledAsset: 'mcp-server.json',
    },
  ];
}

/**
 * Read the bundled asset file as a UTF-8 string. Cached for the lifetime of
 * the process — bundled assets ship inside the published CLI package and
 * never change at runtime.
 */
const bundledAssetCache = new Map<string, string>();
export function loadBundledAsset(descriptor: Descriptor): string {
  const path = join(ASSETS_ROOT, descriptor.bundledAsset);
  let cached = bundledAssetCache.get(path);
  if (cached === undefined) {
    cached = readFileSync(path, 'utf8');
    bundledAssetCache.set(path, cached);
  }
  return cached;
}

/**
 * Memoized canonical-form + sha256 of a descriptor's bundled asset.
 *
 * Hot path: `manager.classify()` runs on every `rayfin dev` invocation and
 * compares the bundled sha to the lockfile's recorded sha. Without this
 * cache, every call re-parses + re-canonicalizes the bundled JSON or
 * frontmatter and re-hashes it. Bundled assets are immutable in-process,
 * so this is computed at most once per descriptor per process.
 */
const bundledShaCache = new Map<
  string,
  { canonical: string; sha256: string }
>();
export function getBundledCanonicalAndSha(descriptor: Descriptor): {
  canonical: string;
  sha256: string;
} {
  const key = `${descriptor.kind}:${descriptor.name}`;
  let cached = bundledShaCache.get(key);
  if (cached === undefined) {
    const canonical = getStrategy(descriptor.kind).canonicalizeBundled(
      loadBundledAsset(descriptor)
    );
    const sha256 = sha256Hex(canonical);
    cached = { canonical, sha256 };
    bundledShaCache.set(key, cached);
  }
  return cached;
}

let cachedAgentsmd: string | undefined;
/** Path to the default AGENTS.md asset; not in the descriptor table because AGENTS.md is one-time install. */
export function getDefaultAgentsmdAsset(): string {
  if (cachedAgentsmd === undefined) {
    cachedAgentsmd = readFileSync(join(ASSETS_ROOT, 'AGENTS.md'), 'utf8');
  }
  return cachedAgentsmd;
}

/**
 * Test-only: clear cached bundled asset content. Real callers never need this —
 * bundled assets are immutable in the shipped package — but Vitest reuses the
 * module graph across test files, so any test that needs to vary asset content
 * must reset the cache between runs.
 */
export function _resetBundledAssetCacheForTests(): void {
  bundledAssetCache.clear();
  bundledShaCache.clear();
  cachedAgentsmd = undefined;
}
