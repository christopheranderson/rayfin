import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import {
  deriveInstallCommand,
  deriveUpdateCommand,
  discoverPackages,
  getCatalog,
  mapDiscoverResult,
} from '../catalog.js';
import { getKnownRayfinDocsPackages } from '../index.js';

interface RushProject {
  packageName: string;
  projectFolder: string;
}

interface RushJson {
  projects: RushProject[];
}

function findRepoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(current, 'rush.json'))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error('Could not find rush.json');
    }
    current = parent;
  }
  return current;
}

function readJsonFile<T>(path: string): T {
  const json = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(json) as T;
}

function readRushProjects(): Map<string, RushProject> {
  const rushJson = readJsonFile<RushJson>(join(findRepoRoot(), 'rush.json'));
  return new Map(
    rushJson.projects
      .filter((project) => project.packageName.startsWith('@microsoft/'))
      .map((project) => [project.packageName, project])
  );
}

describe('getCatalog', () => {
  it('returns a catalog with schemaVersion 1', () => {
    const c = getCatalog();
    expect(c.schemaVersion).toBe(1);
    expect(c.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes all known Rayfin packages', () => {
    const names = getCatalog().packages.map((p) => p.name);
    for (const expected of [
      '@microsoft/rayfin-core',
      '@microsoft/rayfin-data',
      '@microsoft/rayfin-auth',
      '@microsoft/rayfin-cli',
      '@microsoft/rayfin-mcp',
      '@microsoft/rayfin-docs',
      '@microsoft/rayfin-guide',
      '@microsoft/rayfin-host-docs',
      '@microsoft/rayfin-auth-provider-fabric',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('@microsoft/rayfin-catalog');
  });

  it('stays aligned with Rush package projects and rayfinDocs manifests', () => {
    const repoRoot = findRepoRoot();
    const rushProjects = readRushProjects();
    const catalog = getCatalog();
    const catalogNames = new Set(catalog.packages.map((pkg) => pkg.name));

    const catalogPackagesMissingRushProject = catalog.packages
      .map((pkg) => pkg.name)
      .filter((name) => name.startsWith('@microsoft/'))
      .filter((name) => !rushProjects.has(name));
    expect(catalogPackagesMissingRushProject).toEqual([]);

    const documentedRushPackagesMissingCatalog: string[] = [];
    for (const project of rushProjects.values()) {
      const packageJsonPath = join(
        repoRoot,
        project.projectFolder,
        'package.json'
      );
      if (!existsSync(packageJsonPath)) {
        continue;
      }
      const packageJson =
        readJsonFile<Record<string, unknown>>(packageJsonPath);
      if (
        'rayfinDocs' in packageJson &&
        !catalogNames.has(project.packageName)
      ) {
        documentedRushPackagesMissingCatalog.push(project.packageName);
      }
    }
    expect(documentedRushPackagesMissingCatalog).toEqual([]);

    const catalogPackagesMissingManifest = catalog.packages
      .filter((pkg) => pkg.modules.length > 0)
      .filter((pkg) => rushProjects.has(pkg.name))
      .filter((pkg) => {
        const project = rushProjects.get(pkg.name)!;
        const packageJsonPath = join(
          repoRoot,
          project.projectFolder,
          'package.json'
        );
        const packageJson =
          readJsonFile<Record<string, unknown>>(packageJsonPath);
        return !('rayfinDocs' in packageJson);
      })
      .map((pkg) => pkg.name);
    expect(catalogPackagesMissingManifest).toEqual([]);
  });

  it('returns a frozen catalog so consumers cannot mutate it', () => {
    const c = getCatalog();
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.packages)).toBe(true);
    for (const p of c.packages) {
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.topics)).toBe(true);
    }
  });
});

describe('discoverPackages', () => {
  it('returns empty array for empty/whitespace query', () => {
    expect(discoverPackages('')).toEqual([]);
    expect(discoverPackages('   ')).toEqual([]);
  });

  it('matches by package name substring', () => {
    const r = discoverPackages('rayfin-auth');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]?.package.name).toBe('@microsoft/rayfin-auth');
    expect(r[0]?.matchedOn).toContain('name');
  });

  it('does not recommend stable SDK packages without docs modules', () => {
    expect(
      discoverPackages('undocumented', {
        ...getCatalog(),
        packages: [
          {
            name: '@microsoft/rayfin-undocumented',
            kind: 'sdk',
            summary: 'Undocumented SDK',
            topics: ['undocumented'],
            modules: [],
          },
        ],
      })
    ).toEqual([]);
  });

  it('does not recommend experimental packages', () => {
    const storage = getCatalog().packages.find(
      (p) => p.name === '@microsoft/rayfin-storage'
    );
    expect(storage?.stability).toBe('experimental');
    expect(
      discoverPackages('storage').map((s) => s.package.name)
    ).not.toContain('@microsoft/rayfin-storage');
    expect(discoverPackages('blob').map((s) => s.package.name)).not.toContain(
      '@microsoft/rayfin-storage'
    );
  });

  it('marks only the kusto connector experimental', () => {
    const connectors = getCatalog().packages.filter((p) =>
      p.name.startsWith('@microsoft/rayfin-connector')
    );
    expect(connectors.length).toBeGreaterThan(0);
    for (const pkg of connectors) {
      // Kusto/KQL is the one connector still behind the experimental bar.
      const expected =
        pkg.name === '@microsoft/rayfin-connector-kusto'
          ? 'experimental'
          : undefined;
      expect(pkg.stability).toBe(expected);
    }
  });

  it('recommends the generally available connector packages', () => {
    expect(discoverPackages('connectors').map((s) => s.package.name)).toContain(
      '@microsoft/rayfin-connectors'
    );
    expect(
      discoverPackages('semantic-model').map((s) => s.package.name)
    ).toContain('@microsoft/rayfin-connector-fabric-semanticmodel');
    expect(discoverPackages('graphql').map((s) => s.package.name)).toContain(
      '@microsoft/rayfin-connector-fabric-graphql'
    );
  });

  it('does not recommend the experimental kusto connector', () => {
    for (const query of ['connector', 'kusto', 'kql']) {
      expect(discoverPackages(query).map((s) => s.package.name)).not.toContain(
        '@microsoft/rayfin-connector-kusto'
      );
    }
  });

  it('documents both functions packages as stable SDK surfaces', () => {
    const byName = (n: string) => {
      const pkg = getCatalog().packages.find((p) => p.name === n);
      expect(pkg, `${n} missing from catalog`).toBeDefined();
      return pkg!;
    };

    // The client-side invoke surface went GA with the functions CLI commands.
    const client = byName('@microsoft/rayfin-functions');
    expect(client.stability).toBeUndefined();
    expect(client.summary).not.toMatch(/^Experimental/);
    expect(client.modules).toEqual(['rayfin-functions']);

    // `stability` here is a docs classification: it gates the docs site and
    // install recommendations. It is deliberately independent of the package's
    // npm release channel, which `functions-scaffold.ts` pins to the exact
    // running CLI version. The authoring reference belongs alongside the other
    // SDK docs.
    const authoring = byName('@microsoft/fabric-user-data-functions');
    expect(authoring.stability).toBeUndefined();
    expect(authoring.summary).not.toMatch(/^Experimental/);
    expect(authoring.modules).toEqual(['fabric-user-data-functions']);
  });

  it('recommends both documented functions packages', () => {
    const names = discoverPackages('functions').map((s) => s.package.name);
    expect(names).toContain('@microsoft/rayfin-functions');
    expect(names).toContain('@microsoft/fabric-user-data-functions');
    expect(getKnownRayfinDocsPackages()).toContain(
      '@microsoft/rayfin-functions'
    );
    expect(getKnownRayfinDocsPackages()).toContain(
      '@microsoft/fabric-user-data-functions'
    );
  });

  it('still probes experimental packages for docs discovery', () => {
    // `stability` gates install recommendations only. Once a Builder has
    // installed an experimental package its docs must remain discoverable,
    // so it has to stay in the candidate probe list.
    expect(getKnownRayfinDocsPackages()).toContain('@microsoft/rayfin-storage');
  });

  it('still returns no-module tool entries as actionable tool recommendations', () => {
    expect(
      discoverPackages('scaffolding').map((s) => s.package.name)
    ).toContain('@microsoft/create-rayfin');
  });

  it('matches a topic exactly', () => {
    const r = discoverPackages('graphql');
    const data = r.find((s) => s.package.name === '@microsoft/rayfin-data');
    expect(data).toBeDefined();
    expect(data?.matchedOn).toContain('topics');
  });

  it('matches by summary keyword fallback', () => {
    const r = discoverPackages('Microsoft Fabric');
    const fabricProvider = r.find(
      (s) => s.package.name === '@microsoft/rayfin-auth-provider-fabric'
    );
    expect(fabricProvider).toBeDefined();
  });

  it('ranks name match above topic match', () => {
    const r = discoverPackages('auth');
    expect(r[0]?.package.name).toBe('@microsoft/rayfin-auth');
  });

  it('returns empty for completely unrelated queries', () => {
    expect(discoverPackages('zzzznonsensequery')).toEqual([]);
  });

  it('multi-word query "fabric auth" finds the Fabric auth provider', () => {
    const r = discoverPackages('fabric auth');
    const names = r.map((s) => s.package.name);
    expect(names).toContain('@microsoft/rayfin-auth-provider-fabric');
  });

  it('drops stopwords from the query', () => {
    const r = discoverPackages('the and for with how');
    expect(r).toEqual([]);
  });
});

describe('deriveInstallCommand', () => {
  it('defaults to `npm install <name>` for SDK packages', () => {
    const pkg = getCatalog().packages.find(
      (p) => p.name === '@microsoft/rayfin-core'
    )!;
    expect(deriveInstallCommand(pkg)).toBe(
      'npm install @microsoft/rayfin-core'
    );
  });

  it('uses the special command for @microsoft/create-rayfin', () => {
    const pkg = getCatalog().packages.find(
      (p) => p.name === '@microsoft/create-rayfin'
    )!;
    expect(deriveInstallCommand(pkg)).toBe('npm create rayfin@latest');
  });

  it('honors an explicit installCommand override on the catalog entry', () => {
    const override = {
      name: '@external/custom-pkg',
      kind: 'external' as const,
      summary: 'x',
      topics: [],
      modules: [],
      installCommand: 'npm install --legacy-peer-deps @external/custom-pkg',
    };
    expect(deriveInstallCommand(override)).toBe(
      'npm install --legacy-peer-deps @external/custom-pkg'
    );
  });
});

describe('deriveUpdateCommand', () => {
  it('defaults to `npm install <name>@latest` for SDK packages', () => {
    const pkg = getCatalog().packages.find(
      (p) => p.name === '@microsoft/rayfin-core'
    )!;
    expect(deriveUpdateCommand(pkg)).toBe(
      'npm install @microsoft/rayfin-core@latest'
    );
  });

  it('includes update guidance in discover wire items', () => {
    const score = discoverPackages('data')[0]!;
    const item = mapDiscoverResult(score);
    expect(item.updateCommand).toBe(
      'npm install @microsoft/rayfin-data@latest'
    );
    expect(item.versionLockedDocs).toContain(
      'package version installed in the current project'
    );
  });
});
