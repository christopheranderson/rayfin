import { readFileSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { RayfinStaticAccess } from './index.js';

const RAYFIN_CONFIG_RELATIVE_PATH = join('rayfin', 'rayfin.yml');

/**
 * Read `services.staticHosting.assetAccess` from the project's `rayfin.yml`.
 *
 * The file is looked up from `startDir` upwards, matching how `rayfin dev`
 * locates the project root from a frontend package inside a workspace. An
 * unreadable, malformed, or silent configuration yields `undefined` rather
 * than an error: the posture only selects a local convenience, and a dev
 * server must still start for a project that has not chosen an access mode.
 *
 * @param startDir - Directory to begin the upward search from.
 * @returns The declared access mode, or `undefined` when none is declared.
 */
export function readStaticAccess(
  startDir: string
): RayfinStaticAccess | undefined {
  const configPath = findRayfinConfig(startDir);
  if (!configPath) return undefined;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf8'));
  } catch {
    return undefined;
  }

  const assetAccess = readPath(parsed, [
    'services',
    'staticHosting',
    'assetAccess',
  ]);
  return assetAccess === 'protected' || assetAccess === 'public'
    ? assetAccess
    : undefined;
}

function findRayfinConfig(startDir: string): string | undefined {
  const { root } = parsePath(startDir);
  let current = startDir;

  for (;;) {
    const candidate = join(current, RAYFIN_CONFIG_RELATIVE_PATH);
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // Not here; keep walking toward the filesystem root.
    }

    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
