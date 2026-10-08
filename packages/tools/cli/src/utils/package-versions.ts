/**
 * The `packageVersions` map every runtime-settings write declares.
 *
 * The control plane gates static-hosting writes on the CLI entry and records
 * the rest as provenance, so this is assembled from what the deploy would
 * actually ship — the *installed* manifests, not the declared ranges — and
 * attached at the wire boundary rather than stored in `rayfin.yml`.
 *
 * Lives in `utils/` rather than beside the `up` pre-flight because both the
 * legacy command and the v2 workload client need it, and neither should import
 * the other's layer.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join, parse } from 'path';

import { resolveInstalledPackageVersions } from '@microsoft/rayfin-docs/_internal/site-discovery';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';

import { resolveServicePath } from './config-utils.js';
import { CLI_VERSION_KEY } from './runtime-settings.js';
import { getPackageVersion } from './version.js';

/** The auth SDK whose version gates static-hosting access control. */
export const AUTH_SDK_PACKAGE = '@microsoft/rayfin-auth';

/**
 * Read the effective installed version of `packageName` under `packageDir`.
 *
 * Reads the installed package manifest rather than the declared range: a range
 * like `^1.2.0` says nothing about what a deploy would actually bundle.
 *
 * Delegates to the shared {@link resolveInstalledPackageVersions}, which is the
 * same resolver deployment telemetry uses, so a layout this repo learns to
 * handle is handled everywhere at once. It covers the cases this check depends
 * on: an ESM-only package whose `exports` map has no `require` condition, and a
 * hoisted install above the frontend package.
 *
 * Returns `undefined` for every failure, including a `packageDir` that does not
 * exist — the shared resolver throws for that, and an unresolvable version is
 * not a reason to fail a deploy.
 */
export function resolveInstalledVersion(
  packageDir: string,
  packageName: string
): string | undefined {
  try {
    const { packages } = resolveInstalledPackageVersions(
      [packageName],
      packageDir,
      { includeIndirect: true }
    );
    return packages.find((entry) => entry.name === packageName)?.version;
  } catch {
    return undefined;
  }
}

/** Whether the frontend package declares `packageName` in either dependency map. */
export function readDeclaredRange(
  packageDir: string,
  packageName: string
): string | undefined {
  return findDeclaringDirectory(packageDir, packageName)?.range;
}

/**
 * Find the ancestor package that declares `packageName`, and the range it uses.
 *
 * Used to target an upgrade at the manifest that owns the dependency, rather
 * than wherever the lockfile happens to live: for a workspace, those are often
 * different directories, and installing at the wrong one either fails (pnpm
 * rejects adding to the workspace root) or silently edits the wrong manifest.
 */
export function findDeclaringDirectory(
  packageDir: string,
  packageName: string
): { directory: string; range: string } | undefined {
  for (const directory of ancestors(packageDir)) {
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;

    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const range =
      parsed.dependencies?.[packageName] ??
      parsed.devDependencies?.[packageName];
    if (range !== undefined) return { directory, range };
  }

  return undefined;
}

/** Rayfin's published packages, which ship as one lockstep-versioned set. */
const RAYFIN_PACKAGE_PATTERN = /^@microsoft\/(rayfin|fabric)-/;

/**
 * Find the nearest ancestor manifest declaring Rayfin packages, and which ones.
 *
 * The auth SDK is routinely transitive: a project pins
 * `@microsoft/rayfin-auth-provider-fabric` and never names `rayfin-auth`. Since
 * these packages ship in lockstep, upgrading the SDK alone would leave whatever
 * pulled it in behind, producing a half-upgraded graph. Callers use this to move
 * the whole declared set together.
 */
export function findDeclaredRayfinPackages(
  packageDir: string
): { directory: string; packages: string[] } | undefined {
  for (const directory of ancestors(packageDir)) {
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;

    let parsed: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue;
    }

    const packages = [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ]
      .filter((name) => RAYFIN_PACKAGE_PATTERN.test(name))
      .sort();

    if (packages.length > 0) return { directory, packages };
  }

  return undefined;
}

/** Directories from the package context through the filesystem root. */
export function ancestors(packageDir: string): string[] {
  const directories: string[] = [];
  let current = packageDir;
  const root = parse(current).root;
  while (true) {
    directories.push(current);
    if (current === root) return directories;
    current = dirname(current);
  }
}

/**
 * Resolve the auth SDK version this deploy would ship.
 *
 * Keyed on what is *installed*, not on what the manifest declares, so it agrees
 * with the auth SDK pre-flight: that pre-flight upgrades a transitively
 * installed SDK too, and a record that omitted it would describe a deployment
 * that did not happen. Returns `undefined` when the SDK is not installed or its
 * version cannot be read, so the key is omitted rather than declared as unknown.
 */
export function resolveAuthSdkVersion(
  packageDir: string,
  packageName: string = AUTH_SDK_PACKAGE
): string | undefined {
  return resolveInstalledVersion(packageDir, packageName);
}

/**
 * Build the non-CLI half of `packageVersions` for a deploy.
 *
 * The CLI's own entry is added at the wire boundary in `postRuntimeSettings`,
 * so it cannot be overridden by anything assembled here. Keys whose version
 * cannot be resolved are omitted.
 */
export function resolveDeployPackageVersions(
  projectRoot: string | undefined,
  services: RayfinConfig['services'] | undefined
): Record<string, string> | undefined {
  if (!projectRoot) return undefined;

  const packageDir = resolveServicePath(
    projectRoot,
    services?.staticHosting?.path
  );
  const authSdkVersion = resolveAuthSdkVersion(packageDir);

  return authSdkVersion ? { [AUTH_SDK_PACKAGE]: authSdkVersion } : undefined;
}

/**
 * The complete `packageVersions` map a deploy would declare, CLI entry included.
 *
 * Exists for `--dry-run`, which has to report what the real run would send
 * without sending it. Mirrors the assembly order in `postRuntimeSettings`: the
 * CLI entry is written last so nothing else can misreport which CLI ran.
 */
export function resolveDeclaredPackageVersions(
  projectRoot: string | undefined,
  services: RayfinConfig['services'] | undefined
): Record<string, string> {
  return {
    ...resolveDeployPackageVersions(projectRoot, services),
    [CLI_VERSION_KEY]: getPackageVersion(),
  };
}
