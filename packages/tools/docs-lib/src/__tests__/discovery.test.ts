import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveInstalledPackageVersions } from '../discovery.js';
import {
  DocsService,
  defaultTrust,
  discoverRayfinDocsPackages,
  validateRayfinDocsManifest,
} from '../index.js';
import { loadDocsFromPackage } from '../loader.js';

interface FixturePackage {
  name: string;
  version?: string;
  manifest?: Record<string, unknown>;
  docs?: Record<string, string>;
  rawPackageJson?: string;
}

/**
 * Build a temp project layout that mimics a typical npm/pnpm install:
 *
 * ```
 * <tempRoot>/node_modules/<scope>/<pkg>/package.json
 * <tempRoot>/node_modules/<scope>/<pkg>/<dir>/<file>.md
 * ```
 *
 * Returns the project root (parent of `node_modules`) so tests can
 * pass it as `discover.from`.
 */
function makeProject(packages: FixturePackage[]): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'rayfin-discover-'));
  const nodeModules = join(root, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });

  for (const pkg of packages) {
    const pkgDir = join(nodeModules, ...pkg.name.split('/'));
    mkdirSync(pkgDir, { recursive: true });

    if (pkg.rawPackageJson !== undefined) {
      writeFileSync(join(pkgDir, 'package.json'), pkg.rawPackageJson);
    } else {
      const pkgJson = {
        name: pkg.name,
        version: pkg.version ?? '1.0.0',
        ...(pkg.manifest !== undefined ? { rayfinDocs: pkg.manifest } : {}),
      };
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify(pkgJson, null, 2)
      );
    }

    if (pkg.docs) {
      for (const [relPath, content] of Object.entries(pkg.docs)) {
        const filePath = join(pkgDir, relPath);
        const dir = filePath.slice(
          0,
          Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
        );
        mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, content);
      }
    }
  }

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('resolveInstalledPackageVersions', () => {
  it('reads actual versions without requiring a rayfinDocs manifest', () => {
    const project = makeProject([
      { name: '@microsoft/rayfin-core', version: '1.35.0-alpha' },
      { name: '@microsoft/fabric-visuals', version: '1.0.0' },
    ]);
    try {
      expect(
        resolveInstalledPackageVersions(
          [
            '@microsoft/rayfin-core',
            '@microsoft/fabric-visuals',
            '@microsoft/rayfin-core',
          ],
          project.root
        )
      ).toEqual({
        packages: [
          { name: '@microsoft/fabric-visuals', version: '1.0.0' },
          { name: '@microsoft/rayfin-core', version: '1.35.0-alpha' },
        ],
        unresolvedPackageNames: [],
      });
    } finally {
      project.cleanup();
    }
  });

  it('resolves hoisted packages from a nested project', () => {
    const project = makeProject([
      { name: '@microsoft/rayfin-core', version: '2.0.0' },
    ]);
    const nested = join(project.root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    try {
      expect(
        resolveInstalledPackageVersions(['@microsoft/rayfin-core'], nested)
      ).toEqual({
        packages: [{ name: '@microsoft/rayfin-core', version: '2.0.0' }],
        unresolvedPackageNames: [],
      });
    } finally {
      project.cleanup();
    }
  });

  describe('includeIndirect', () => {
    /**
     * A strict/isolated install: the consumer is a symlink into a virtual
     * store, and the target exists only as its sibling there — never in the
     * project's own `node_modules`.
     */
    function makeIsolatedProject(): { root: string; cleanup: () => void } {
      const root = mkdtempSync(join(tmpdir(), 'rayfin-isolated-'));
      const store = join(
        root,
        'node_modules',
        '.store',
        'consumer@1.0.0',
        'node_modules'
      );
      const consumerDir = join(store, '@microsoft', 'consumer');
      const targetDir = join(store, '@microsoft', 'target');
      mkdirSync(consumerDir, { recursive: true });
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(
        join(consumerDir, 'package.json'),
        JSON.stringify({
          name: '@microsoft/consumer',
          version: '1.0.0',
          dependencies: { '@microsoft/target': '^3.0.0' },
        })
      );
      writeFileSync(
        join(targetDir, 'package.json'),
        JSON.stringify({ name: '@microsoft/target', version: '3.1.4' })
      );
      const scopeDir = join(root, 'node_modules', '@microsoft');
      mkdirSync(scopeDir, { recursive: true });
      symlinkSync(
        consumerDir,
        join(scopeDir, 'consumer'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'app',
          dependencies: { '@microsoft/consumer': '^1.0.0' },
        })
      );
      return {
        root,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    }

    it('omits an indirect dependency by default', () => {
      const project = makeIsolatedProject();
      try {
        expect(
          resolveInstalledPackageVersions(['@microsoft/target'], project.root)
        ).toEqual({
          packages: [],
          unresolvedPackageNames: ['@microsoft/target'],
        });
      } finally {
        project.cleanup();
      }
    });

    it('resolves an indirect dependency when asked to', () => {
      const project = makeIsolatedProject();
      try {
        expect(
          resolveInstalledPackageVersions(['@microsoft/target'], project.root, {
            includeIndirect: true,
          })
        ).toEqual({
          packages: [{ name: '@microsoft/target', version: '3.1.4' }],
          unresolvedPackageNames: [],
        });
      } finally {
        project.cleanup();
      }
    });

    it('still reports a package nothing in the graph provides', () => {
      const project = makeIsolatedProject();
      try {
        expect(
          resolveInstalledPackageVersions(['@microsoft/absent'], project.root, {
            includeIndirect: true,
          })
        ).toEqual({
          packages: [],
          unresolvedPackageNames: ['@microsoft/absent'],
        });
      } finally {
        project.cleanup();
      }
    });
  });

  it('omits missing, malformed, and mismatched package manifests', () => {
    const project = makeProject([
      { name: '@microsoft/malformed', rawPackageJson: 'not json' },
      {
        name: '@microsoft/mismatched',
        rawPackageJson: JSON.stringify({
          name: '@microsoft/other',
          version: '1.0.0',
        }),
      },
    ]);
    try {
      expect(
        resolveInstalledPackageVersions(
          [
            '@microsoft/malformed',
            '@microsoft/mismatched',
            '@microsoft/missing',
            '@microsoft/../../package',
          ],
          project.root
        )
      ).toEqual({
        packages: [],
        unresolvedPackageNames: [
          '@microsoft/../../package',
          '@microsoft/malformed',
          '@microsoft/mismatched',
          '@microsoft/missing',
        ],
      });
    } finally {
      project.cleanup();
    }
  });

  it('classifies versions rejected by the caller policy as unresolved', () => {
    const project = makeProject([
      { name: '@microsoft/rayfin-core', version: 'workspace:*' },
    ]);
    try {
      expect(
        resolveInstalledPackageVersions(
          ['@microsoft/rayfin-core'],
          project.root,
          { isVersionAllowed: (version) => version === '1.0.0' }
        )
      ).toEqual({
        packages: [],
        unresolvedPackageNames: ['@microsoft/rayfin-core'],
      });
    } finally {
      project.cleanup();
    }
  });
});

describe('validateRayfinDocsManifest', () => {
  const validPkg = {
    rayfinDocs: {
      version: 1,
      dir: 'assets/docs',
      module: 'rayfin-core',
      kind: 'api-reference',
    },
  };

  it('accepts a valid manifest', () => {
    const r = validateRayfinDocsManifest(validPkg, '@microsoft/rayfin-core');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.module).toBe('rayfin-core');
      expect(r.manifest.kind).toBe('api-reference');
    }
  });

  it('defaults missing dir to assets/docs', () => {
    const r = validateRayfinDocsManifest(
      {
        rayfinDocs: {
          version: 1,
          module: 'rayfin-core',
          kind: 'api-reference',
        },
      },
      '@microsoft/rayfin-core'
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.dir).toBe('assets/docs');
    }
  });

  it('rejects empty dir', () => {
    const r = validateRayfinDocsManifest(
      { rayfinDocs: { ...validPkg.rayfinDocs, dir: '' } },
      'x'
    );
    expect(r.ok).toBe(false);
  });

  it('returns missing for packages without rayfinDocs', () => {
    const r = validateRayfinDocsManifest({ name: 'foo' }, 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('missing');
  });

  it('rejects unsupported manifest version', () => {
    const r = validateRayfinDocsManifest(
      { rayfinDocs: { ...validPkg.rayfinDocs, version: 2 } },
      'x'
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === 'invalid') {
      expect(r.reason).toMatch(/version/i);
    }
  });

  it('rejects parent-directory traversal in dir', () => {
    const r = validateRayfinDocsManifest(
      { rayfinDocs: { ...validPkg.rayfinDocs, dir: '../escape' } },
      'x'
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === 'invalid') {
      expect(r.reason).toMatch(/traverse|\.\./);
    }
  });

  it('rejects absolute dir', () => {
    const r = validateRayfinDocsManifest(
      { rayfinDocs: { ...validPkg.rayfinDocs, dir: '/abs/path' } },
      'x'
    );
    expect(r.ok).toBe(false);
  });

  it('rejects unknown kind', () => {
    const r = validateRayfinDocsManifest(
      { rayfinDocs: { ...validPkg.rayfinDocs, kind: 'unknown' } },
      'x'
    );
    expect(r.ok).toBe(false);
  });

  it('rejects empty module', () => {
    const r = validateRayfinDocsManifest(
      { rayfinDocs: { ...validPkg.rayfinDocs, module: '' } },
      'x'
    );
    expect(r.ok).toBe(false);
  });
});

describe('defaultTrust', () => {
  it('trusts @microsoft/rayfin-* packages', () => {
    expect(defaultTrust('@microsoft/rayfin-core')).toBe(true);
    expect(defaultTrust('@microsoft/rayfin-guide')).toBe(true);
  });

  it('trusts the first-party packages outside the rayfin- naming convention', () => {
    expect(defaultTrust('@microsoft/fabric-user-data-functions')).toBe(true);
  });

  it('matches the allow-list by exact name, not by prefix', () => {
    expect(defaultTrust('@microsoft/fabric-user-data-functions-impostor')).toBe(
      false
    );
  });

  it('does not trust other scopes', () => {
    expect(defaultTrust('@microsoft/some-other-pkg')).toBe(false);
    expect(defaultTrust('lodash')).toBe(false);
    expect(defaultTrust('@evil/rayfin-impostor')).toBe(false);
  });
});

describe('discoverRayfinDocsPackages', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('discovers a trusted package with a valid manifest', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md':
            '# Rayfin Core\n\nIntroduction to the core SDK.',
        },
      },
    ]);
    cleanup = c;

    const result = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@microsoft/rayfin-core'],
    });

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.packageName).toBe('@microsoft/rayfin-core');
    expect(result.discovered[0]?.packageVersion).toBe('1.0.0');
    expect(result.discovered[0]?.manifest.kind).toBe('api-reference');
    expect(result.notInstalled).toEqual([]);
    expect(result.untrustedSkipped).toEqual([]);
    expect(result.invalidManifest).toEqual([]);
  });

  it('resolves packages from the caller project directory and walks parent node_modules', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        version: '1.2.3',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Local Core\n\nlocalprojectuniquetoken.',
        },
      },
    ]);
    cleanup = c;
    const nestedProjectDir = join(root, 'src', 'features');
    mkdirSync(nestedProjectDir, { recursive: true });

    const result = discoverRayfinDocsPackages({
      from: nestedProjectDir,
      candidates: ['@microsoft/rayfin-core'],
    });

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.packageVersion).toBe('1.2.3');
    expect(result.discovered[0]?.packageRoot).toBe(
      join(root, 'node_modules', '@microsoft', 'rayfin-core')
    );
  });

  it('uses the project package over an unrelated global tool install', () => {
    const { root: projectRoot, cleanup: cleanupProject } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        version: '1.2.3',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Local Core\n\nlocalprojectuniquetoken.',
        },
      },
    ]);
    const { cleanup: cleanupTool } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        version: '9.9.9',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Global Core\n\nglobaltooluniquetoken.',
        },
      },
    ]);
    cleanup = () => {
      cleanupProject();
      cleanupTool();
    };
    const nestedProjectDir = join(projectRoot, 'src');
    mkdirSync(nestedProjectDir, { recursive: true });

    const service = new DocsService({
      cache: false,
      discover: {
        from: nestedProjectDir,
      },
    });

    expect(service.searchDocs('localprojectuniquetoken')).toHaveLength(1);
    expect(service.searchDocs('globaltooluniquetoken')).toHaveLength(0);
    expect(service.getDiscoveryReport()?.discovered[0]?.packageVersion).toBe(
      '1.2.3'
    );
  });

  it('serves different docs for different project roots on the same machine', () => {
    const { root: appA, cleanup: cleanupAppA } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        version: '1.20.0',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# App A Core\n\nappaversiontoken.',
        },
      },
    ]);
    const { root: appB, cleanup: cleanupAppB } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        version: '1.26.0',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# App B Core\n\nappbversiontoken.',
        },
      },
    ]);
    cleanup = () => {
      cleanupAppA();
      cleanupAppB();
    };

    const serviceA = new DocsService({
      cache: false,
      discover: {
        from: appA,
      },
    });
    const serviceB = new DocsService({
      cache: false,
      discover: {
        from: appB,
      },
    });

    expect(serviceA.searchDocs('appaversiontoken')).toHaveLength(1);
    expect(serviceA.searchDocs('appbversiontoken')).toHaveLength(0);
    expect(serviceA.getDiscoveryReport()?.discovered[0]?.packageVersion).toBe(
      '1.20.0'
    );
    expect(serviceB.searchDocs('appbversiontoken')).toHaveLength(1);
    expect(serviceB.searchDocs('appaversiontoken')).toHaveLength(0);
    expect(serviceB.getDiscoveryReport()?.discovered[0]?.packageVersion).toBe(
      '1.26.0'
    );
  });

  it('requires explicit opt-in before scanning every installed package', () => {
    const { root, cleanup: c } = makeProject([]);
    cleanup = c;

    expect(() => discoverRayfinDocsPackages({ from: root })).toThrow(
      /requires an explicit source/
    );
  });

  it('rejects ambiguous discovery sources instead of silently picking one', () => {
    const { root, cleanup: c } = makeProject([]);
    cleanup = c;

    expect(() =>
      discoverRayfinDocsPackages({
        from: root,
        candidates: [],
        scanInstalledPackages: true,
      })
    ).toThrow(/requires exactly one explicit source/);
    expect(() =>
      discoverRayfinDocsPackages({
        from: root,
        candidates: [],
        packageRoots: [],
      })
    ).toThrow(/requires exactly one explicit source/);
    expect(() =>
      discoverRayfinDocsPackages({
        from: root,
        packageRoots: [],
        scanInstalledPackages: true,
      })
    ).toThrow(/requires exactly one explicit source/);
  });

  it('treats empty explicit sources as no-op sources', () => {
    const { root, cleanup: c } = makeProject([]);
    cleanup = c;

    const candidatesResult = discoverRayfinDocsPackages({
      from: root,
      candidates: [],
    });
    const packageRootsResult = discoverRayfinDocsPackages({
      from: root,
      packageRoots: [],
    });

    expect(candidatesResult.discovered).toEqual([]);
    expect(packageRootsResult.discovered).toEqual([]);
  });

  it('discovers installed rayfinDocs packages with all-installed scanning enabled', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Rayfin Core',
        },
      },
      {
        name: '@microsoft/rayfin-data',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-data',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Rayfin Data',
        },
      },
    ]);
    cleanup = c;

    const result = discoverRayfinDocsPackages({
      from: root,
      scanInstalledPackages: true,
    });

    expect(result.discovered.map((pkg) => pkg.packageName).sort()).toEqual([
      '@microsoft/rayfin-core',
      '@microsoft/rayfin-data',
    ]);
    expect(result.notInstalled).toEqual([]);
  });

  it('discovers pnpm-style symlinked packages with all-installed scanning enabled', () => {
    const { root, cleanup: c } = makeProject([]);
    cleanup = c;
    const storePackageRoot = join(root, '.pnpm-store', 'rayfin-core');
    mkdirSync(join(storePackageRoot, 'assets', 'docs'), { recursive: true });
    writeFileSync(
      join(storePackageRoot, 'package.json'),
      JSON.stringify({
        name: '@microsoft/rayfin-core',
        version: '1.2.3',
        rayfinDocs: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
      })
    );
    writeFileSync(
      join(storePackageRoot, 'assets', 'docs', 'index.md'),
      '# Rayfin Core'
    );
    const scopeRoot = join(root, 'node_modules', '@microsoft');
    mkdirSync(scopeRoot, { recursive: true });
    symlinkSync(storePackageRoot, join(scopeRoot, 'rayfin-core'), 'junction');

    const result = discoverRayfinDocsPackages({
      from: root,
      scanInstalledPackages: true,
    });

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.packageName).toBe('@microsoft/rayfin-core');
    expect(result.discovered[0]?.packageVersion).toBe('1.2.3');
  });

  it('discovers explicit workspace package roots', () => {
    const { root, cleanup: c } = makeProject([]);
    cleanup = c;
    const packageRoot = join(root, 'workspace-package');
    mkdirSync(join(packageRoot, 'assets', 'docs'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@microsoft/rayfin-guide',
        version: '2.3.4',
        rayfinDocs: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-guide',
          kind: 'guide',
        },
      })
    );
    writeFileSync(
      join(packageRoot, 'assets', 'docs', 'index.md'),
      '# Rayfin Guide'
    );

    const result = discoverRayfinDocsPackages({
      from: root,
      packageRoots: [packageRoot],
    });

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.packageName).toBe('@microsoft/rayfin-guide');
    expect(result.discovered[0]?.packageVersion).toBe('2.3.4');
    expect(result.notInstalled).toEqual([]);
  });

  it('skips packages outside the default trust list', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@evil/rayfin-impostor',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'impostor',
          kind: 'guide',
        },
      },
    ]);
    cleanup = c;

    const result = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@evil/rayfin-impostor'],
    });

    expect(result.discovered).toHaveLength(0);
    expect(result.untrustedSkipped).toEqual(['@evil/rayfin-impostor']);
  });

  it('skips untrusted candidate names before marking them not installed', () => {
    const { root, cleanup: c } = makeProject([]);
    cleanup = c;

    const result = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@evil/rayfin-impostor'],
    });

    expect(result.discovered).toHaveLength(0);
    expect(result.notInstalled).toEqual([]);
    expect(result.untrustedSkipped).toEqual(['@evil/rayfin-impostor']);
    expect(result.invalidManifest).toEqual([]);
  });

  it('reports not-installed candidates without throwing', () => {
    const { root, cleanup: c } = makeProject([]);
    cleanup = c;

    const result = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@microsoft/rayfin-core'],
    });

    expect(result.notInstalled).toEqual(['@microsoft/rayfin-core']);
    expect(result.discovered).toHaveLength(0);
  });

  it('records invalid manifests rather than throwing', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 2,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
      },
    ]);
    cleanup = c;

    const result = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@microsoft/rayfin-core'],
    });

    expect(result.discovered).toHaveLength(0);
    expect(result.invalidManifest).toHaveLength(1);
    expect(result.invalidManifest[0]?.packageName).toBe(
      '@microsoft/rayfin-core'
    );
  });

  it('rejects rayfinDocs packages without a package version', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        rawPackageJson: JSON.stringify({
          name: '@microsoft/rayfin-core',
          rayfinDocs: {
            version: 1,
            dir: 'assets/docs',
            module: 'rayfin-core',
            kind: 'api-reference',
          },
        }),
      },
    ]);
    cleanup = c;

    const result = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@microsoft/rayfin-core'],
    });

    expect(result.discovered).toHaveLength(0);
    expect(result.invalidManifest).toEqual([
      {
        packageName: '@microsoft/rayfin-core',
        reason:
          'package.json must declare a non-empty string version when rayfinDocs is present',
      },
    ]);
  });

  it('silently skips packages without rayfinDocs (not all packages have migrated)', () => {
    const { root, cleanup: c } = makeProject([
      { name: '@microsoft/rayfin-other' },
    ]);
    cleanup = c;

    const result = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@microsoft/rayfin-other'],
    });

    expect(result.discovered).toHaveLength(0);
    expect(result.invalidManifest).toHaveLength(0);
  });

  it('honors a custom trust predicate that opens the namespace', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: 'my-third-party-rayfin-pkg',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'tp',
          kind: 'guide',
        },
      },
    ]);
    cleanup = c;

    const result = discoverRayfinDocsPackages({
      from: root,
      candidates: ['my-third-party-rayfin-pkg'],
      trust: () => true,
    });

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.packageName).toBe('my-third-party-rayfin-pkg');
    expect(result.discovered[0]?.packageVersion).toBe('1.0.0');
  });
});

describe('loadDocsFromPackage', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('walks the package docs dir and tags each entry with source metadata', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md':
            '# Rayfin Core\n\nThe core SDK package.\n\n## RayfinClient\n\nMain entry point.',
          'assets/docs/auth.md': '# Auth\n\n## signIn\n\nSign-in helper.',
        },
      },
    ]);
    cleanup = c;

    const { discovered } = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@microsoft/rayfin-core'],
    });
    expect(discovered).toHaveLength(1);

    const entries = loadDocsFromPackage(discovered[0]!);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.module).toBe('ts-sdk');
      expect(entry.id).toMatch(/^rayfin-core:/);
      expect(entry.source?.module).toBe('rayfin-core');
      expect(entry.source?.kind).toBe('api-reference');
      expect(entry.source?.packageName).toBe('@microsoft/rayfin-core');
      expect(entry.source?.packageVersion).toBe('1.0.0');
    }
  });

  it('skips a package whose docs root symlink escapes the package root', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
      },
    ]);
    const externalRoot = mkdtempSync(join(tmpdir(), 'rayfin-external-docs-'));
    cleanup = () => {
      c();
      rmSync(externalRoot, { recursive: true, force: true });
    };
    mkdirSync(join(externalRoot, 'docs'), { recursive: true });
    writeFileSync(join(externalRoot, 'docs', 'index.md'), '# External Docs');
    const packageRoot = join(root, 'node_modules', '@microsoft', 'rayfin-core');
    mkdirSync(join(packageRoot, 'assets'), { recursive: true });
    symlinkSync(
      join(externalRoot, 'docs'),
      join(packageRoot, 'assets', 'docs'),
      'junction'
    );

    const { discovered } = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@microsoft/rayfin-core'],
    });
    expect(discovered).toHaveLength(1);
    expect(loadDocsFromPackage(discovered[0]!)).toEqual([]);
  });

  it('skips symlinked files inside the package docs dir', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Safe Docs\n\nLocal content.',
        },
      },
    ]);
    const externalRoot = mkdtempSync(join(tmpdir(), 'rayfin-external-docs-'));
    cleanup = () => {
      c();
      rmSync(externalRoot, { recursive: true, force: true });
    };
    const externalFile = join(externalRoot, 'leaked.md');
    writeFileSync(externalFile, '# External Docs');
    const docsRoot = join(
      root,
      'node_modules',
      '@microsoft',
      'rayfin-core',
      'assets',
      'docs'
    );
    try {
      symlinkSync(externalFile, join(docsRoot, 'leaked.md'), 'file');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'EPERM'
      ) {
        return;
      }
      throw error;
    }

    const { discovered } = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@microsoft/rayfin-core'],
    });
    expect(discovered).toHaveLength(1);
    const entries = loadDocsFromPackage(discovered[0]!);
    expect(entries.map((entry) => entry.title)).toEqual(['Safe Docs']);
  });

  it('does not recurse into symlinked package docs subdirectories', () => {
    const { root, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Safe Docs\n\nLocal content.',
        },
      },
    ]);
    const externalRoot = mkdtempSync(join(tmpdir(), 'rayfin-external-docs-'));
    cleanup = () => {
      c();
      rmSync(externalRoot, { recursive: true, force: true });
    };
    mkdirSync(join(externalRoot, 'docs'), { recursive: true });
    writeFileSync(join(externalRoot, 'docs', 'leaked.md'), '# External Docs');
    const docsRoot = join(
      root,
      'node_modules',
      '@microsoft',
      'rayfin-core',
      'assets',
      'docs'
    );
    symlinkSync(
      join(externalRoot, 'docs'),
      join(docsRoot, 'external'),
      'junction'
    );

    const { discovered } = discoverRayfinDocsPackages({
      from: root,
      candidates: ['@microsoft/rayfin-core'],
    });
    expect(discovered).toHaveLength(1);
    const entries = loadDocsFromPackage(discovered[0]!);
    expect(entries.map((entry) => entry.title)).toEqual(['Safe Docs']);
  });
});

describe('DocsService dual-source mode', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('composes bundled assetsRoot + discovered packages', () => {
    // Bundled corpus: legacy assetsRoot/docs/<module>/ layout
    const bundledRoot = mkdtempSync(join(tmpdir(), 'rayfin-bundled-'));
    mkdirSync(join(bundledRoot, 'docs', 'guide'), { recursive: true });
    writeFileSync(
      join(bundledRoot, 'docs', 'guide', 'overview.md'),
      '# Overview\n\nBuilder overview.'
    );

    // Discovered package: rayfin-core ships its own docs
    const { root: projectRoot, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/api.md':
            '# Core API\n\n## RayfinClient\n\nThe entry point.',
        },
      },
    ]);
    cleanup = () => {
      c();
      rmSync(bundledRoot, { recursive: true, force: true });
    };

    const service = new DocsService({
      assetsRoot: bundledRoot,
      cache: false,
      discover: {
        from: projectRoot,
        candidates: ['@microsoft/rayfin-core'],
      },
      modules: ['guide', 'host', 'ts-sdk'],
    });

    const all = service.listDocs();
    // Bundled overview + discovered api doc.
    expect(all.length).toBeGreaterThanOrEqual(2);
    const titles = all.map((e) => e.title);
    expect(titles).toContain('Overview');
    expect(titles).toContain('Core API');

    // Discovery report surfaces what got loaded.
    const report = service.getDiscoveryReport();
    expect(report?.discovered).toHaveLength(1);
    expect(report?.discovered[0]?.packageVersion).toBe('1.0.0');
  });

  it('throws when neither assetsRoot nor discover is provided', () => {
    expect(() => new DocsService({})).toThrow(/at least one source/);
  });

  it('keeps discovered package ids globally unique when paths collide', () => {
    const { root: projectRoot, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Core Docs',
        },
      },
      {
        name: '@microsoft/rayfin-data',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-data',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Data Docs',
        },
      },
    ]);
    cleanup = c;

    const service = new DocsService({
      cache: false,
      discover: {
        from: projectRoot,
        candidates: ['@microsoft/rayfin-core', '@microsoft/rayfin-data'],
      },
    });

    const sdkDocs = service.listDocs('ts-sdk');
    expect(sdkDocs.map((entry) => entry.id).sort()).toEqual([
      'rayfin-core:index.md',
      'rayfin-data:index.md',
    ]);
    expect(service.getDocById('rayfin-core:index.md')?.title).toBe('Core Docs');
    expect(service.getDocById('rayfin-data:index.md')?.title).toBe('Data Docs');
    expect(service.getDocsByPath('index.md').map((entry) => entry.id)).toEqual([
      'rayfin-core:index.md',
      'rayfin-data:index.md',
    ]);
    expect(service.getDocByPath('index.md')).toBeUndefined();
  });

  it('keeps compatibility-corpus and per-package docs distinct', () => {
    // Both sources expose a doc named api.md, but discovered package docs
    // use the manifest module prefix for globally unique ids.
    const bundledRoot = mkdtempSync(join(tmpdir(), 'rayfin-bundled-'));
    mkdirSync(join(bundledRoot, 'docs', 'ts-sdk'), { recursive: true });
    writeFileSync(
      join(bundledRoot, 'docs', 'ts-sdk', 'api.md'),
      '# Bundled Title'
    );

    const { root: projectRoot, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/api.md': '# Per-Package Title',
        },
      },
    ]);
    cleanup = () => {
      c();
      rmSync(bundledRoot, { recursive: true, force: true });
    };

    // Bundled writes to `docs/ts-sdk/api.md` while discovered writes to
    // `rayfin-core:api.md`. They should coexist as separate physical docs.
    const service = new DocsService({
      assetsRoot: bundledRoot,
      cache: false,
      discover: {
        from: projectRoot,
        candidates: ['@microsoft/rayfin-core'],
      },
      modules: ['ts-sdk'],
    });

    const all = service.listDocs('ts-sdk');
    const titles = all.map((e) => e.title);
    expect(titles).toContain('Bundled Title');
    expect(titles).toContain('Per-Package Title');
  });

  it('resolves package-qualified symbols across discovered packages', () => {
    const { root: projectRoot, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-core',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-core',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Core Docs\n\n## Config\n\nCore config.',
        },
      },
      {
        name: '@microsoft/rayfin-data',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-data',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Data Docs\n\n## Config\n\nData config.',
        },
      },
    ]);
    cleanup = c;

    const service = new DocsService({
      cache: false,
      discover: {
        from: projectRoot,
        candidates: ['@microsoft/rayfin-core', '@microsoft/rayfin-data'],
      },
    });

    expect(service.getSymbolDocs('Config')).toHaveLength(2);
    const qualified = service.getSymbolDocs('@microsoft/rayfin-data::Config');
    expect(qualified).toHaveLength(1);
    expect(qualified[0]?.source?.packageName).toBe('@microsoft/rayfin-data');
    expect(service.getSymbolDocs('rayfin-core::Config')).toHaveLength(1);
  });

  it('scopes DocsService default discovery to known Rayfin docs packages', () => {
    const { root: projectRoot, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-future',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-future',
          kind: 'api-reference',
        },
        docs: {
          'assets/docs/index.md': '# Future Docs\n\nfutureuniquetoken.',
        },
      },
    ]);
    cleanup = c;

    const service = new DocsService({
      cache: false,
      discover: {
        from: projectRoot,
      },
    });

    expect(service.searchDocs('futureuniquetoken')).toHaveLength(0);
    expect(service.getDiscoveryReport()?.notInstalled.length).toBeGreaterThan(
      0
    );
  });

  it('caches only packages selected by the requested modules', () => {
    const { root: projectRoot, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-guide',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-guide',
          kind: 'guide',
        },
        docs: {
          'assets/docs/index.md': '# Guide Docs',
        },
      },
      {
        name: '@microsoft/rayfin-host',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-host',
          kind: 'host',
        },
        docs: {
          'assets/docs/index.md': '# Host Docs',
        },
      },
    ]);
    const cacheDir = join(projectRoot, '.rayfin-cache');
    cleanup = c;

    new DocsService({
      cache: { dir: cacheDir },
      discover: {
        from: projectRoot,
        candidates: ['@microsoft/rayfin-guide', '@microsoft/rayfin-host'],
      },
      modules: ['guide'],
    });

    const cacheFiles = readdirSync(cacheDir).filter((name) =>
      name.startsWith('docs-index-')
    );
    expect(cacheFiles).toHaveLength(1);

    const cached = JSON.parse(
      readFileSync(join(cacheDir, cacheFiles[0]!), 'utf8')
    ) as {
      entries: Array<{ module: string; source?: { packageName: string } }>;
    };
    expect(cached.entries.map((entry) => entry.module)).toEqual(['guide']);
    expect(cached.entries.map((entry) => entry.source?.packageName)).toEqual([
      '@microsoft/rayfin-guide',
    ]);
  });

  it('removes stale discovered index caches after package changes', () => {
    const { root: projectRoot, cleanup: c } = makeProject([
      {
        name: '@microsoft/rayfin-guide',
        manifest: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-guide',
          kind: 'guide',
        },
        docs: {
          'assets/docs/index.md': '# Guide Docs',
        },
      },
    ]);
    const cacheDir = join(projectRoot, '.rayfin-cache');
    cleanup = c;

    new DocsService({
      cache: { dir: cacheDir },
      discover: {
        from: projectRoot,
        candidates: ['@microsoft/rayfin-guide'],
      },
      modules: ['guide'],
    });
    const firstCacheFiles = readdirSync(cacheDir).filter((name) =>
      name.startsWith('docs-index-')
    );
    expect(firstCacheFiles).toHaveLength(1);

    writeFileSync(
      join(
        projectRoot,
        'node_modules',
        '@microsoft',
        'rayfin-guide',
        'package.json'
      ),
      JSON.stringify({
        name: '@microsoft/rayfin-guide',
        version: '2.0.0',
        rayfinDocs: {
          version: 1,
          dir: 'assets/docs',
          module: 'rayfin-guide',
          kind: 'guide',
        },
      })
    );

    new DocsService({
      cache: { dir: cacheDir },
      discover: {
        from: projectRoot,
        candidates: ['@microsoft/rayfin-guide'],
      },
      modules: ['guide'],
    });

    const secondCacheFiles = readdirSync(cacheDir).filter((name) =>
      name.startsWith('docs-index-')
    );
    expect(secondCacheFiles).toHaveLength(1);
    expect(secondCacheFiles[0]).not.toBe(firstCacheFiles[0]);
  });
});
