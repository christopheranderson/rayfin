import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTH_SDK_PACKAGE,
  resolveAuthSdkVersion,
  resolveDeclaredPackageVersions,
  resolveDeployPackageVersions,
} from '../package-versions.js';
import { CLI_VERSION_KEY } from '../runtime-settings.js';
import { getPackageVersion } from '../version.js';

const staticHostingServices = {
  auth: { enabled: true },
  data: { enabled: false },
  staticHosting: { enabled: true, path: 'web' },
} as unknown as RayfinConfig['services'];

describe('package versions', () => {
  let projectRoot: string;
  let packageDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-pkgversions-'));
    packageDir = join(projectRoot, 'web');
    mkdirSync(packageDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeManifest(dependencies: Record<string, string>): void {
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'web', dependencies })
    );
  }

  function writeInstalled(version: string): void {
    const dir = join(
      packageDir,
      'node_modules',
      ...AUTH_SDK_PACKAGE.split('/')
    );
    mkdirSync(dir, { recursive: true });
    // Mirrors the real package: an ESM-only `exports` map with no `require`/
    // `default` condition, so a require.resolve-based lookup would throw
    // ERR_PACKAGE_PATH_NOT_EXPORTED even though the package is installed.
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: AUTH_SDK_PACKAGE,
        version,
        type: 'module',
        exports: { '.': { types: './index.d.ts', import: './index.js' } },
      })
    );
    writeFileSync(join(dir, 'index.js'), '');
  }

  describe('resolveAuthSdkVersion', () => {
    it('reports the installed version, not the declared range', () => {
      writeManifest({ [AUTH_SDK_PACKAGE]: '^1.30.0' });
      writeInstalled('1.35.2');

      expect(resolveAuthSdkVersion(packageDir)).toBe('1.35.2');
    });

    // The pre-flight upgrades a transitively installed SDK, so omitting it here
    // would describe a deployment that did not happen.
    it('reports an installed copy the manifest does not declare', () => {
      writeManifest({});
      writeInstalled('1.35.2');

      expect(resolveAuthSdkVersion(packageDir)).toBe('1.35.2');
    });

    it('returns undefined when the dependency is declared but not installed', () => {
      writeManifest({ [AUTH_SDK_PACKAGE]: '^1.30.0' });

      expect(resolveAuthSdkVersion(packageDir)).toBeUndefined();
    });

    it('returns undefined when there is no manifest to read', () => {
      expect(resolveAuthSdkVersion(packageDir)).toBeUndefined();
    });

    it('reports an SDK hoisted to the workspace root', () => {
      const frontendDir = join(packageDir, 'packages', 'frontend');
      mkdirSync(frontendDir, { recursive: true });
      writeInstalled('1.35.2');

      expect(resolveAuthSdkVersion(frontendDir)).toBe('1.35.2');
    });

    // pnpm's virtual store links a purely transitive dependency only inside
    // the consumer's own dependency scope, never the frontend's ancestor
    // `node_modules` — this is the layout a real `@microsoft/rayfin-client`
    // dependency produces under pnpm without hoisting.
    it('resolves an SDK linked only inside a known consumer (pnpm virtual store)', () => {
      const storeEntry = join(
        packageDir,
        'node_modules',
        '.pnpm',
        '@microsoft+rayfin-client@1.0.0',
        'node_modules'
      );
      const realClientDir = join(storeEntry, '@microsoft', 'rayfin-client');
      const realAuthDir = join(storeEntry, '@microsoft', 'rayfin-auth');
      mkdirSync(realClientDir, { recursive: true });
      mkdirSync(realAuthDir, { recursive: true });
      writeFileSync(
        join(realClientDir, 'package.json'),
        JSON.stringify({ name: '@microsoft/rayfin-client', version: '1.0.0' })
      );
      writeFileSync(
        join(realAuthDir, 'package.json'),
        JSON.stringify({ name: AUTH_SDK_PACKAGE, version: '1.35.2' })
      );

      const linkedClientDir = join(packageDir, 'node_modules', '@microsoft');
      mkdirSync(linkedClientDir, { recursive: true });
      symlinkSync(
        realClientDir,
        join(linkedClientDir, 'rayfin-client'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      expect(resolveAuthSdkVersion(packageDir)).toBe('1.35.2');
    });

    // The dependency graph is walked rather than a fixed list of known
    // consumers, so an SDK reached through a package this repo has never heard
    // of resolves the same way.
    it('resolves an SDK reached through an arbitrary third-party consumer', () => {
      writeManifest({ '@acme/ui-kit': '^2.0.0' });

      const storeEntry = join(
        packageDir,
        'node_modules',
        '.pnpm',
        '@acme+ui-kit@2.0.0',
        'node_modules'
      );
      const realConsumerDir = join(storeEntry, '@acme', 'ui-kit');
      const realAuthDir = join(storeEntry, ...AUTH_SDK_PACKAGE.split('/'));
      mkdirSync(realConsumerDir, { recursive: true });
      mkdirSync(realAuthDir, { recursive: true });
      writeFileSync(
        join(realConsumerDir, 'package.json'),
        JSON.stringify({
          name: '@acme/ui-kit',
          version: '2.0.0',
          dependencies: { [AUTH_SDK_PACKAGE]: '^1.35.0' },
        })
      );
      writeFileSync(
        join(realAuthDir, 'package.json'),
        JSON.stringify({ name: AUTH_SDK_PACKAGE, version: '1.35.9' })
      );

      const scopeDir = join(packageDir, 'node_modules', '@acme');
      mkdirSync(scopeDir, { recursive: true });
      symlinkSync(
        realConsumerDir,
        join(scopeDir, 'ui-kit'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      expect(resolveAuthSdkVersion(packageDir)).toBe('1.35.9');
    });

    // A package that is genuinely absent must stay absent: the graph walk
    // must not report a version for something nothing depends on.
    it('returns undefined when no package in the graph provides the SDK', () => {
      writeManifest({ '@acme/ui-kit': '^2.0.0' });

      const consumerDir = join(packageDir, 'node_modules', '@acme', 'ui-kit');
      mkdirSync(consumerDir, { recursive: true });
      writeFileSync(
        join(consumerDir, 'package.json'),
        JSON.stringify({ name: '@acme/ui-kit', version: '2.0.0' })
      );

      expect(resolveAuthSdkVersion(packageDir)).toBeUndefined();
    });
  });

  describe('resolveDeployPackageVersions', () => {
    it('includes the auth SDK the frontend package ships', () => {
      writeManifest({ [AUTH_SDK_PACKAGE]: '^1.30.0' });
      writeInstalled('1.35.2');

      expect(
        resolveDeployPackageVersions(projectRoot, staticHostingServices)
      ).toEqual({ [AUTH_SDK_PACKAGE]: '1.35.2' });
    });

    // Omitted rather than sent as empty or zero, so the control plane can tell
    // "no SDK" from "unknown SDK".
    it('omits the key entirely when the dependency is absent', () => {
      writeManifest({});

      expect(
        resolveDeployPackageVersions(projectRoot, staticHostingServices)
      ).toBeUndefined();
    });

    it('returns undefined without a project root', () => {
      expect(
        resolveDeployPackageVersions(undefined, staticHostingServices)
      ).toBeUndefined();
    });
  });

  describe('resolveDeclaredPackageVersions', () => {
    it('always declares the running CLI version', () => {
      writeManifest({});

      expect(
        resolveDeclaredPackageVersions(projectRoot, staticHostingServices)
      ).toEqual({ [CLI_VERSION_KEY]: getPackageVersion() });
    });

    it('adds the auth SDK when the frontend package ships it', () => {
      writeManifest({ [AUTH_SDK_PACKAGE]: '^1.30.0' });
      writeInstalled('1.35.2');

      expect(
        resolveDeclaredPackageVersions(projectRoot, staticHostingServices)
      ).toEqual({
        [AUTH_SDK_PACKAGE]: '1.35.2',
        [CLI_VERSION_KEY]: getPackageVersion(),
      });
    });

    // The dictionary describes the deployment happening now, so a stale value
    // committed to rayfin.yml must not be able to misreport which CLI ran.
    it('cannot be overridden by a resolved key', () => {
      writeManifest({});

      const declared = resolveDeclaredPackageVersions(projectRoot, {
        ...staticHostingServices,
        packageVersions: { [CLI_VERSION_KEY]: '0.0.1-stale' },
      } as unknown as RayfinConfig['services']);

      expect(declared[CLI_VERSION_KEY]).toBe(getPackageVersion());
    });
  });
});
