/**
 * Version utilities for the Rayfin CLI
 * Combines package.json version with build timestamp
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** npm name of this package, used to confirm a manifest is ours. */
const CLI_PACKAGE_NAME = '@microsoft/rayfin-cli';

interface BuildInfo {
  buildTimestamp: string;
  buildDate: string;
}

interface PackageJson {
  version: string;
  name: string;
}

/**
 * Read this package's own manifest by walking up from this module until one
 * names {@link CLI_PACKAGE_NAME}.
 *
 * Mirrors the entry-point tier of `resolveInstalledPackageVersions` in
 * `docs-lib`, but anchored on this module rather than a project directory: the
 * version identifies the CLI that is *running*, which is not necessarily the
 * one a project happens to have installed. Matching on `name` rather than a
 * fixed `../../` depth means a build-layout change surfaces as `Unknown`
 * instead of silently reporting some nested dependency's version.
 */
function readOwnPackageJson(): PackageJson | undefined {
  let dir = __dirname;
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(
          readFileSync(candidate, 'utf8')
        ) as Partial<PackageJson>;
        if (
          parsed.name === CLI_PACKAGE_NAME &&
          typeof parsed.version === 'string'
        ) {
          return parsed as PackageJson;
        }
      } catch {
        // Keep walking toward the package root.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Get the version string including build timestamp
 */
export function getVersionString(): string {
  const packageJson = readOwnPackageJson();
  if (!packageJson) return 'Unknown';

  let buildInfo: BuildInfo | null = null;
  try {
    const buildInfoPath = resolve(__dirname, '..', 'build-info.json');
    buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
  } catch {
    // Build info not available, continue without it
  }

  return buildInfo
    ? `${packageJson.version} (built ${buildInfo.buildDate})`
    : `${packageJson.version} (build timestamp unavailable)`;
}

/**
 * Get just the package version without build info
 */
export function getPackageVersion(): string {
  return readOwnPackageJson()?.version ?? 'Unknown';
}
