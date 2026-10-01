import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncSafeMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/platform-utils.js', () => ({
  spawnSyncSafe: spawnSyncSafeMock,
}));

const {
  AUTH_SDK_MIN_VERSION,
  AUTH_SDK_PACKAGE,
  assertAuthSdkMinVersionResolved,
  compareSemver,
  detectPackageManager,
  inspectAuthSdk,
  isAuthSdkMinVersionPlaceholder,
  upgradeAuthSdk,
} = await import('../auth-sdk-preflight.js');

const MIN = '2.0.0';

describe('auth SDK preflight', () => {
  let packageDir: string;

  beforeEach(() => {
    spawnSyncSafeMock.mockReset();
    packageDir = mkdtempSync(join(tmpdir(), 'rayfin-authsdk-'));
  });

  afterEach(() => {
    rmSync(packageDir, { recursive: true, force: true });
  });

  describe('compareSemver', () => {
    it.each([
      ['1.0.0', '2.0.0', -1],
      ['2.0.0', '2.0.0', 0],
      ['2.0.1', '2.0.0', 1],
      ['2.1.0', '2.0.9', 1],
      ['10.0.0', '9.0.0', 1],
    ])('orders %s against %s', (left, right, expected) => {
      expect(Math.sign(compareSemver(left, right))).toBe(expected);
    });

    it('sorts a prerelease below its matching release', () => {
      expect(compareSemver('2.0.0-alpha', '2.0.0')).toBeLessThan(0);
    });

    it.each([
      // The shipped floors carry build-counter suffixes, so a lexical compare
      // would order 1413 below 9 and wave through an outdated SDK.
      ['1.35.0-alpha.1413', '1.35.0-alpha.9', 1],
      ['1.35.0-alpha.9', '1.35.0-alpha.1413', -1],
      ['1.35.0-alpha.1413', '1.35.0-alpha.1413', 0],
      ['1.35.0-alpha.2', '1.35.0-alpha.10', -1],
      // A shorter identifier set precedes a longer one with the same prefix.
      ['1.34.0-beta', '1.34.0-beta.0', -1],
      // Numeric identifiers rank below alphanumeric ones.
      ['1.35.0-1', '1.35.0-alpha', -1],
      ['1.35.0-alpha.1413', '1.35.0-beta.0', -1],
    ])('orders prerelease %s against %s', (left, right, expected) => {
      expect(Math.sign(compareSemver(left, right))).toBe(expected);
    });

    it('returns NaN for an uncomparable version', () => {
      expect(Number.isNaN(compareSemver('not-a-version', MIN))).toBe(true);
    });
  });

  describe('inspectAuthSdk', () => {
    it('reports absent when the dependency is neither installed nor declared', () => {
      writeManifest(packageDir, {});

      expect(inspectAuthSdk(packageDir, MIN)).toEqual({ state: 'absent' });
    });

    it('reports outdated when the dependency is installed transitively', () => {
      writeManifest(packageDir, {});
      writeInstalled(packageDir, AUTH_SDK_PACKAGE, '1.9.9');

      expect(inspectAuthSdk(packageDir, MIN)).toEqual({
        state: 'outdated',
        version: '1.9.9',
      });
    });

    it('reports current when the installed version meets the floor', () => {
      writeManifest(packageDir, { [AUTH_SDK_PACKAGE]: '^2.0.0' });
      writeInstalled(packageDir, AUTH_SDK_PACKAGE, '2.3.1');

      expect(inspectAuthSdk(packageDir, MIN)).toEqual({
        state: 'current',
        version: '2.3.1',
      });
    });

    it('reports outdated when the installed version is below the floor', () => {
      writeManifest(packageDir, { [AUTH_SDK_PACKAGE]: '^1.0.0' });
      writeInstalled(packageDir, AUTH_SDK_PACKAGE, '1.9.9');

      expect(inspectAuthSdk(packageDir, MIN)).toEqual({
        state: 'outdated',
        version: '1.9.9',
      });
    });

    it('detects the dependency in devDependencies', () => {
      writeManifest(packageDir, {}, { [AUTH_SDK_PACKAGE]: '^1.0.0' });
      writeInstalled(packageDir, AUTH_SDK_PACKAGE, '1.0.0');

      expect(inspectAuthSdk(packageDir, MIN).state).toBe('outdated');
    });

    it('uses the installed version rather than the declared range', () => {
      writeManifest(packageDir, { [AUTH_SDK_PACKAGE]: '^2.0.0' });
      writeInstalled(packageDir, AUTH_SDK_PACKAGE, '1.0.0');

      expect(inspectAuthSdk(packageDir, MIN).state).toBe('outdated');
    });

    it('reports unresolved when the dependency is declared but not installed', () => {
      writeManifest(packageDir, { [AUTH_SDK_PACKAGE]: '^1.0.0' });

      const result = inspectAuthSdk(packageDir, MIN);

      expect(result.state).toBe('unresolved');
      expect(result).toHaveProperty(
        'reason',
        expect.stringContaining('not installed')
      );
    });

    it('reports unresolved when the installed version cannot be compared', () => {
      writeManifest(packageDir, { [AUTH_SDK_PACKAGE]: '^1.0.0' });
      writeInstalled(packageDir, AUTH_SDK_PACKAGE, 'workspace:*');

      expect(inspectAuthSdk(packageDir, MIN).state).toBe('unresolved');
    });

    it('reports absent when the package has no manifest at all', () => {
      expect(inspectAuthSdk(packageDir, MIN)).toEqual({ state: 'absent' });
    });

    it('resolves an SDK hoisted to the workspace root', () => {
      const frontendDir = join(packageDir, 'packages', 'frontend');
      mkdirSync(frontendDir, { recursive: true });
      writeManifest(frontendDir, {});
      writeManifest(packageDir, { [AUTH_SDK_PACKAGE]: '^1.0.0' });
      writeInstalled(packageDir, AUTH_SDK_PACKAGE, '1.9.9');

      expect(inspectAuthSdk(frontendDir, MIN)).toEqual({
        state: 'outdated',
        version: '1.9.9',
      });
    });
  });

  describe('detectPackageManager', () => {
    it.each([
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
    ])('selects %s', (lockfile, expected) => {
      writeFileSync(join(packageDir, lockfile), '');

      expect(detectPackageManager(packageDir)).toBe(expected);
    });

    it('returns undefined when no lockfile is present', () => {
      expect(detectPackageManager(packageDir)).toBeUndefined();
    });

    it('finds a workspace-root lockfile from a nested frontend', () => {
      const frontendDir = join(packageDir, 'packages', 'frontend');
      mkdirSync(frontendDir, { recursive: true });
      writeFileSync(join(packageDir, 'package-lock.json'), '');

      expect(detectPackageManager(frontendDir)).toBe('npm');
    });
  });

  describe('upgradeAuthSdk', () => {
    it('fails with recovery guidance when no lockfile selects a package manager', () => {
      const result = upgradeAuthSdk(packageDir, MIN);

      expect(result.status).toBe('failed');
      expect(spawnSyncSafeMock).not.toHaveBeenCalled();
    });

    it('runs the detected package manager and reports success', () => {
      writeFileSync(join(packageDir, 'package-lock.json'), '');
      spawnSyncSafeMock.mockReturnValue({ status: 0 });

      const result = upgradeAuthSdk(packageDir, MIN);

      expect(result).toEqual({ status: 'upgraded', packageManager: 'npm' });
      expect(spawnSyncSafeMock).toHaveBeenCalledWith(
        'npm',
        ['install', `${AUTH_SDK_PACKAGE}@^${MIN}`, '--save'],
        expect.objectContaining({ cwd: packageDir })
      );
    });

    it('uses yarn add when a yarn lockfile is present', () => {
      writeFileSync(join(packageDir, 'yarn.lock'), '');
      spawnSyncSafeMock.mockReturnValue({ status: 0 });

      upgradeAuthSdk(packageDir, MIN);

      expect(spawnSyncSafeMock).toHaveBeenCalledWith(
        'yarn',
        ['add', `${AUTH_SDK_PACKAGE}@^${MIN}`],
        expect.objectContaining({ cwd: packageDir })
      );
    });

    it('uses pnpm add when a pnpm lockfile is present', () => {
      writeFileSync(join(packageDir, 'pnpm-lock.yaml'), '');
      spawnSyncSafeMock.mockReturnValue({ status: 0 });

      upgradeAuthSdk(packageDir, MIN);

      expect(spawnSyncSafeMock).toHaveBeenCalledWith(
        'pnpm',
        ['add', `${AUTH_SDK_PACKAGE}@^${MIN}`],
        expect.objectContaining({ cwd: packageDir })
      );
    });

    it('targets the frontend package for a purely transitive SDK, not the workspace root', () => {
      const frontendDir = join(packageDir, 'packages', 'frontend');
      mkdirSync(frontendDir, { recursive: true });
      writeFileSync(join(packageDir, 'pnpm-lock.yaml'), '');
      spawnSyncSafeMock.mockReturnValue({ status: 0 });

      upgradeAuthSdk(frontendDir, MIN);

      // pnpm rejects a plain add at the workspace root (ERR_PNPM_ADDING_TO_ROOT),
      // so the lockfile ancestor selects the package manager only.
      expect(spawnSyncSafeMock).toHaveBeenCalledWith(
        'pnpm',
        ['add', `${AUTH_SDK_PACKAGE}@^${MIN}`],
        expect.objectContaining({ cwd: frontendDir })
      );
    });

    it('targets the manifest that declares the dependency, even when the lockfile is elsewhere', () => {
      const frontendDir = join(packageDir, 'packages', 'frontend');
      mkdirSync(frontendDir, { recursive: true });
      writeFileSync(join(packageDir, 'pnpm-lock.yaml'), '');
      writeFileSync(
        join(frontendDir, 'package.json'),
        JSON.stringify({ dependencies: { [AUTH_SDK_PACKAGE]: '^1.0.0' } })
      );
      spawnSyncSafeMock.mockReturnValue({ status: 0 });

      upgradeAuthSdk(frontendDir, MIN);

      expect(spawnSyncSafeMock).toHaveBeenCalledWith(
        'pnpm',
        ['add', `${AUTH_SDK_PACKAGE}@^${MIN}`],
        expect.objectContaining({ cwd: frontendDir })
      );
    });

    it('passes -w when the dependency is actually declared at the pnpm workspace root', () => {
      const frontendDir = join(packageDir, 'packages', 'frontend');
      mkdirSync(frontendDir, { recursive: true });
      writeFileSync(join(packageDir, 'pnpm-lock.yaml'), '');
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ dependencies: { [AUTH_SDK_PACKAGE]: '^1.0.0' } })
      );
      spawnSyncSafeMock.mockReturnValue({ status: 0 });

      upgradeAuthSdk(frontendDir, MIN);

      expect(spawnSyncSafeMock).toHaveBeenCalledWith(
        'pnpm',
        ['add', `${AUTH_SDK_PACKAGE}@^${MIN}`, '-w'],
        expect.objectContaining({ cwd: packageDir })
      );
    });

    it('passes -W when the dependency is actually declared at the yarn workspace root', () => {
      const frontendDir = join(packageDir, 'packages', 'frontend');
      mkdirSync(frontendDir, { recursive: true });
      writeFileSync(join(packageDir, 'yarn.lock'), '');
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ dependencies: { [AUTH_SDK_PACKAGE]: '^1.0.0' } })
      );
      spawnSyncSafeMock.mockReturnValue({ status: 0 });

      upgradeAuthSdk(frontendDir, MIN);

      expect(spawnSyncSafeMock).toHaveBeenCalledWith(
        'yarn',
        ['add', `${AUTH_SDK_PACKAGE}@^${MIN}`, '-W'],
        expect.objectContaining({ cwd: packageDir })
      );
    });

    it('fails with recovery guidance when the package manager exits non-zero', () => {
      writeFileSync(join(packageDir, 'package-lock.json'), '');
      spawnSyncSafeMock.mockReturnValue({ status: 1 });

      const result = upgradeAuthSdk(packageDir, MIN);

      expect(result.status).toBe('failed');
      expect(result).toHaveProperty(
        'error',
        expect.stringContaining('npm install')
      );
    });
  });

  describe('minimum-version placeholder guard', () => {
    it('recognises the unresolved placeholder', () => {
      expect(isAuthSdkMinVersionPlaceholder('0.0.0-PLACEHOLDER')).toBe(true);
      expect(isAuthSdkMinVersionPlaceholder('2.0.0')).toBe(false);
    });

    it('blocks the preflight while the floor is a placeholder', () => {
      expect(assertAuthSdkMinVersionResolved('0.0.0-PLACEHOLDER')).toContain(
        'has not been set'
      );
    });
    it('allows the preflight once a real version is set', () => {
      expect(assertAuthSdkMinVersionResolved('2.0.0')).toBeUndefined();
    });

    it('ships a resolved floor, so the check is live', () => {
      expect(isAuthSdkMinVersionPlaceholder(AUTH_SDK_MIN_VERSION)).toBe(false);
      expect(assertAuthSdkMinVersionResolved()).toBeUndefined();
    });
  });
});

function writeManifest(
  dir: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string> = {}
): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'frontend', dependencies, devDependencies })
  );
}

function writeInstalled(dir: string, name: string, version: string): void {
  const target = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js' })
  );
  writeFileSync(join(target, 'index.js'), '');
}
