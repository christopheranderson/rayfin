import { readFileSync } from 'fs';
import { join, relative, resolve } from 'path';

import {
  discoverRayfinDocsPackages,
  type DiscoveredPackage,
  type DocKind,
} from '@microsoft/rayfin-docs/_internal/site-discovery';

export interface RayfinSiteDocsSource {
  id: string;
  label: string;
  packageName: string;
  packageVersion: string;
  kind: DocKind;
  module: string;
  path: string;
  repositoryPath: string;
  routeBasePath: string;
}

const siteRoot = __dirname;
const repoRoot = resolve(siteRoot, '..', '..');

interface RushJson {
  projects?: Array<{ projectFolder?: unknown }>;
}

interface CatalogFile {
  packages?: Array<{ name?: unknown; stability?: unknown }>;
}

/**
 * Package names the catalog marks `stability: 'experimental'`.
 *
 * The public docs site is a stable surface. Package discovery only asks
 * whether a package ships a `rayfinDocs` manifest, so without this gate an
 * experimental package would get a route and sidebar entry on the stable SDK
 * reference even while `discoverPackages()` deliberately refuses to recommend
 * it. Read the catalog that ships inside `@microsoft/rayfin-docs` rather than
 * a repo-relative path so the two stay in sync.
 */
function getExperimentalPackageNames(): Set<string> {
  const catalogPath = resolve(
    require.resolve('@microsoft/rayfin-docs/package.json'),
    '..',
    'assets',
    'catalog.json'
  );
  const catalog = JSON.parse(
    readFileSync(catalogPath, 'utf8')
  ) as CatalogFile;
  return new Set(
    (catalog.packages ?? [])
      .filter((pkg) => pkg.stability === 'experimental')
      .map((pkg) => pkg.name)
      .filter((name): name is string => typeof name === 'string')
  );
}

function stripJsonComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function getWorkspacePackageRoots(): string[] {
  const rushJson = JSON.parse(
    stripJsonComments(readFileSync(resolve(repoRoot, 'rush.json'), 'utf8'))
  ) as RushJson;
  return (rushJson.projects ?? [])
    .map((project) => project.projectFolder)
    .filter((projectFolder): projectFolder is string => !!projectFolder)
    .map((projectFolder) => resolve(repoRoot, projectFolder));
}

function sourceLabel(pkg: DiscoveredPackage): string {
  if (pkg.manifest.kind === 'api-reference') {
    return pkg.packageName;
  }
  if (pkg.manifest.kind === 'host') {
    return 'Host Reference';
  }
  return 'Guide';
}

function sourceRouteBasePath(pkg: DiscoveredPackage): string {
  switch (pkg.manifest.kind) {
    case 'guide':
      return 'docs/guide';
    case 'host':
      return 'docs/host';
    case 'api-reference':
      return `docs/ts-sdk/${pkg.manifest.module}`;
  }
}

function toSiteRelativePath(path: string): string {
  return relative(siteRoot, path).replace(/\\/g, '/');
}

export function getRayfinSiteDocsSources(): RayfinSiteDocsSource[] {
  const report = discoverRayfinDocsPackages({
    from: siteRoot,
    packageRoots: getWorkspacePackageRoots(),
  });

  if (report.invalidManifest.length > 0) {
    const summary = report.invalidManifest
      .map((entry) => `${entry.packageName}: ${entry.reason}`)
      .join('; ');
    throw new Error(`Invalid rayfinDocs site source: ${summary}`);
  }
  if (report.untrustedSkipped.length > 0) {
    throw new Error(
      `Untrusted rayfinDocs site source: ${report.untrustedSkipped.join(', ')}`
    );
  }

  const experimental = getExperimentalPackageNames();

  return report.discovered
    .filter((pkg) => !experimental.has(pkg.packageName))
    .map((pkg) => ({
    id: `rayfin-${pkg.manifest.module}`,
    label: sourceLabel(pkg),
    packageName: pkg.packageName,
    packageVersion: pkg.packageVersion,
    kind: pkg.manifest.kind,
    module: pkg.manifest.module,
    path: toSiteRelativePath(join(pkg.packageRoot, pkg.manifest.dir)),
    repositoryPath: relative(repoRoot, join(pkg.packageRoot, pkg.manifest.dir))
      .replace(/\\/g, '/'),
    routeBasePath: sourceRouteBasePath(pkg),
  }));
}
