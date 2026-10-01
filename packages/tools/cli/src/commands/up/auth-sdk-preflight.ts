/**
 * Minimum auth SDK check for `rayfin up`.
 *
 * Static-hosting access control changes how a deployed app acquires its
 * session, so an app whose frontend still bundles an older `@microsoft/rayfin-auth`
 * can deploy successfully and then fail to sign anyone in. This module checks
 * the installed dependency before anything is published and upgrades it in place
 * when it is behind the supported floor.
 *
 * Scope is deliberately narrow: it upgrades an SDK already present in the
 * installed dependency graph. It never installs the SDK when it is absent,
 * because whether an app needs it is the Builder's decision, not a deploy-time
 * one.
 *
 * Gated by the `cli-up-anonstatic` feature flag at the call sites.
 */
import { existsSync } from 'fs';
import { join } from 'path';

import inquirer from 'inquirer';

import {
  AUTH_SDK_PACKAGE,
  ancestors,
  findDeclaringDirectory,
  readDeclaredRange,
  resolveAuthSdkVersion,
} from '../../utils/package-versions.js';
import { spawnSyncSafe } from '../../utils/platform-utils.js';

export { AUTH_SDK_PACKAGE } from '../../utils/package-versions.js';

/**
 * Lowest `@microsoft/rayfin-auth` version compatible with static-hosting
 * access control.
 *
 * Raise this only alongside a release. `assertAuthSdkMinVersionResolved` still
 * guards the placeholder form so a future re-templating cannot ship a floor
 * that silently reports every version as current.
 */
export const AUTH_SDK_MIN_VERSION = '1.35.0-alpha.1541';

/** Whether {@link AUTH_SDK_MIN_VERSION} is still the unresolved placeholder. */
export function isAuthSdkMinVersionPlaceholder(
  minVersion: string = AUTH_SDK_MIN_VERSION
): boolean {
  return minVersion.includes('PLACEHOLDER');
}

/** Package managers whose lockfile the CLI can drive an upgrade through. */
export type SupportedPackageManager = 'npm' | 'pnpm' | 'yarn';

/** Outcome of inspecting the frontend package's auth SDK dependency. */
export type AuthSdkInspection =
  /** Not installed or declared — nothing to upgrade or install. */
  | { state: 'absent' }
  /** Installed and already at or above the floor. */
  | { state: 'current'; version: string }
  /** Installed but behind the floor. */
  | { state: 'outdated'; version: string }
  /** The effective version could not be determined. */
  | { state: 'unresolved'; reason: string };

/**
 * Compare two semver versions.
 *
 * Returns a negative number when `left` precedes `right`. Only the parts this
 * check needs are modelled: the numeric triplet, and prerelease sorting below
 * the matching release. Build metadata is not stripped, so a `+build` suffix
 * folds into the final numeric component — harmless for a floor comparison.
 */
export function compareSemver(left: string, right: string): number {
  const parse = (
    value: string
  ): { parts: number[]; prerelease: string[] | undefined } => {
    const [core, ...rest] = value.trim().replace(/^v/, '').split('-');
    return {
      parts: core.split('.').map((part) => Number.parseInt(part, 10)),
      prerelease: rest.length > 0 ? rest.join('-').split('.') : undefined,
    };
  };

  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < 3; index++) {
    const one = a.parts[index] ?? 0;
    const two = b.parts[index] ?? 0;
    if (Number.isNaN(one) || Number.isNaN(two)) return Number.NaN;
    if (one !== two) return one - two;
  }

  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
}

/**
 * Compare dot-separated prerelease identifiers per semver §11.
 *
 * Numeric identifiers compare numerically, so `alpha.1413` sorts above
 * `alpha.9` rather than below it as a plain string compare would have it —
 * which matters because the released floors use build-counter suffixes.
 */
function comparePrereleaseIdentifiers(left: string[], right: string[]): number {
  const isNumeric = (value: string): boolean => /^\d+$/.test(value);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const one = left[index];
    const two = right[index];

    // A shorter identifier set precedes a longer one with the same prefix.
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    if (one === two) continue;

    const oneNumeric = isNumeric(one);
    const twoNumeric = isNumeric(two);
    if (oneNumeric && twoNumeric) {
      return Number.parseInt(one, 10) - Number.parseInt(two, 10);
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (oneNumeric !== twoNumeric) return oneNumeric ? -1 : 1;
    return one < two ? -1 : 1;
  }

  return 0;
}

/**
 * Inspect the auth SDK dependency of the static-hosting frontend package.
 *
 * @param packageDir - Directory of the frontend package (resolved from
 *   `services.staticHosting.path`, or the project root).
 */
export function inspectAuthSdk(
  packageDir: string,
  minVersion: string = AUTH_SDK_MIN_VERSION,
  packageName: string = AUTH_SDK_PACKAGE
): AuthSdkInspection {
  const installed = resolveAuthSdkVersion(packageDir, packageName);
  if (installed === undefined) {
    let declared: string | undefined;
    try {
      declared = readDeclaredRange(packageDir, packageName);
    } catch (error) {
      return {
        state: 'unresolved',
        reason: `package.json in ${packageDir} could not be read: ${(error as Error).message}`,
      };
    }

    if (declared === undefined) {
      return { state: 'absent' };
    }

    return {
      state: 'unresolved',
      reason: `${packageName} is declared as "${declared}" but is not installed, so its effective version is unknown`,
    };
  }

  const comparison = compareSemver(installed, minVersion);
  if (Number.isNaN(comparison)) {
    return {
      state: 'unresolved',
      reason: `${packageName} version "${installed}" could not be compared with the minimum supported version`,
    };
  }

  return comparison < 0
    ? { state: 'outdated', version: installed }
    : { state: 'current', version: installed };
}

/**
 * Pick the package manager from the lockfile the project already keeps.
 *
 * Deliberately not unified with the same-shaped helper in
 * `utils/template-scaffold.ts`: that one defaults to `npm` when no lockfile is
 * found, which is right for scaffolding a new project and wrong here — running
 * the wrong package manager against an existing lockfile rewrites it. This one
 * returns `undefined` so the caller fails with an explanation instead.
 */
export function detectPackageManager(
  packageDir: string
): SupportedPackageManager | undefined {
  return findPackageManagerContext(packageDir)?.packageManager;
}

function findPackageManagerContext(
  packageDir: string
): { packageManager: SupportedPackageManager; directory: string } | undefined {
  for (const directory of ancestors(packageDir)) {
    if (existsSync(join(directory, 'pnpm-lock.yaml'))) {
      return { packageManager: 'pnpm', directory };
    }
    if (existsSync(join(directory, 'yarn.lock'))) {
      return { packageManager: 'yarn', directory };
    }
    if (existsSync(join(directory, 'package-lock.json'))) {
      return { packageManager: 'npm', directory };
    }
  }
  return undefined;
}

/** Result of an attempted in-place auth SDK upgrade. */
export type AuthSdkUpgradeResult =
  | { status: 'upgraded'; packageManager: SupportedPackageManager }
  | { status: 'failed'; error: string };

/**
 * Upgrade the auth SDK to at least the minimum, updating manifest and lockfile.
 *
 * Runs the project's own package manager rather than editing `package.json`
 * directly, so the lockfile cannot drift out of step with the manifest.
 *
 * The lockfile ancestor only selects *which* package manager to run: in a
 * workspace, the lockfile usually lives at the root while the dependency is
 * declared (or should land) in the frontend package. The install itself runs
 * against whichever ancestor manifest already declares `packageName`, falling
 * back to `packageDir` for a purely transitive SDK — never the workspace root,
 * which pnpm refuses to add plain dependencies to (`ERR_PNPM_ADDING_TO_ROOT`)
 * and npm/yarn would add to as a new, unrelated root dependency.
 */
export function upgradeAuthSdk(
  packageDir: string,
  minVersion: string = AUTH_SDK_MIN_VERSION,
  packageName: string = AUTH_SDK_PACKAGE
): AuthSdkUpgradeResult {
  return upgradeRayfinPackages(packageDir, [packageName], minVersion);
}

/**
 * Upgrade a set of Rayfin packages together, in one resolution.
 *
 * They ship in lockstep, so raising only the auth SDK can leave the package
 * that pulled it in on an older major — a graph that installs cleanly and then
 * fails at runtime. Every name goes into a single package-manager invocation so
 * the resolver picks one consistent set rather than several sequential ones.
 */
export function upgradeRayfinPackages(
  packageDir: string,
  packageNames: string[],
  minVersion: string = AUTH_SDK_MIN_VERSION
): AuthSdkUpgradeResult {
  const named = packageNames.join(', ');
  const context = findPackageManagerContext(packageDir);
  if (!context) {
    return {
      status: 'failed',
      error:
        `No supported lockfile was found in ${packageDir}, so ${named} cannot be upgraded automatically.\n` +
        `   Install dependencies with npm, pnpm, or yarn, or upgrade them to ${minVersion} or later yourself, then re-run.`,
    };
  }

  const { packageManager } = context;
  // The first declared name locates the owning manifest; a purely transitive
  // set has none, so the frontend package is the right place to land them.
  const declaring = packageNames
    .map((name) => findDeclaringDirectory(packageDir, name))
    .find((found) => found !== undefined);
  const directory = declaring?.directory ?? packageDir;
  const specs = packageNames.map((name) => `${name}@^${minVersion}`);
  const args =
    packageManager === 'npm'
      ? ['install', ...specs, '--save']
      : ['add', ...specs];

  // pnpm and Yarn workspaces both refuse a plain add at the workspace root
  // (`ERR_PNPM_ADDING_TO_ROOT`, the Yarn equivalent) unless told explicitly
  // that the root is the intended target. Only relevant when the packages are
  // actually declared there — the purely-transitive fallback above targets
  // the frontend package instead, which is never the workspace root.
  if (declaring !== undefined && directory === context.directory) {
    if (packageManager === 'pnpm') args.push('-w');
    if (packageManager === 'yarn') args.push('-W');
  }

  const result = spawnSyncSafe(packageManager, args, {
    cwd: directory,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    return {
      status: 'failed',
      error:
        `${packageManager} could not upgrade ${named} to ${minVersion} or later (exit code ${result.status ?? 'unknown'}).\n` +
        `   Run '${packageManager} ${args.join(' ')}' in ${directory} to see the full output, then re-run.`,
    };
  }

  return { status: 'upgraded', packageManager };
}

/**
 * Ask before changing the Builder's dependency versions.
 *
 * The CLI cannot tell whether the Builder pinned the auth SDK directly or
 * reached it through a provider package, so it names every Rayfin package it
 * would move and lets them decide, rather than silently editing a manifest.
 */
export async function promptForRayfinPackageUpgrade(
  packages: string[]
): Promise<boolean> {
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      default: true,
      message:
        'Update these Rayfin packages to a supported version?\n' +
        packages.map((name) => `     • ${name}`).join('\n') +
        '\n ',
    },
  ]);

  return confirmed;
}

/**
 * Guard that keeps the unresolved placeholder from silently passing.
 *
 * Returns an explanation when the floor is still a placeholder. Comparing real
 * versions against it would report every one of them as current, so callers
 * skip the check and say so rather than pretending it ran.
 */
export function assertAuthSdkMinVersionResolved(
  minVersion: string = AUTH_SDK_MIN_VERSION
): string | undefined {
  if (!isAuthSdkMinVersionPlaceholder(minVersion)) return undefined;
  return (
    `The minimum supported ${AUTH_SDK_PACKAGE} version has not been set for this CLI build, ` +
    'so the auth SDK compatibility check was skipped.'
  );
}
