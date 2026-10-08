/**
 * Per-package docs discovery - Phase 2 of `docs-package-architecture`.
 *
 * Walks a project's `node_modules` to find packages declaring the
 * `rayfinDocs` field in their `package.json`. Returns a list of
 * discovered package roots so `DocsService` can load each tree's
 * markdown alongside any explicit `assetsRoot`.
 *
 * **Trust model.** Discovery is conservative by default: only
 * `@microsoft/rayfin-*` scoped packages are auto-trusted. Anything else
 * requires the caller to pass an explicit `trust` predicate. This
 * matches the spec-review resolution that broad walking is too trusting
 * (see `openspec/changes/docs-package-architecture/spec-review-findings.md`,
 * finding B3).
 *
 * Discovery is intentionally explicit: callers choose either a fixed
 * candidate list, workspace package roots, or all-installed node_modules
 * walking via `scanInstalledPackages: true`.
 */
import {
  readFileSync,
  existsSync,
  realpathSync,
  statSync,
  readdirSync,
} from 'fs';
import { createRequire } from 'module';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { DocKind, RayfinDocsManifest } from './types.js';
export type { DocKind } from './types.js';

/**
 * A package discovered to declare `rayfinDocs`. Returned by package
 * discovery for `DocsService` to load.
 */
export interface DiscoveredPackage {
  packageName: string;
  packageVersion: string;
  packageRoot: string;
  manifest: RayfinDocsManifest;
}

/**
 * Function deciding whether a candidate package should be considered
 * trusted enough to discover. The default ({@link defaultTrust}) accepts
 * `@microsoft/rayfin-*` packages plus a short allow-list of first-party
 * packages that predate that naming convention. Tests override this.
 */
export type TrustPredicate = (packageName: string) => boolean;

/**
 * First-party Rayfin packages whose published names do not start with
 * `@microsoft/rayfin-`.
 *
 * Matched by exact name, never by prefix, so a lookalike such as
 * `@microsoft/fabric-user-data-functions-impostor` stays untrusted.
 */
const TRUSTED_NON_RAYFIN_PACKAGES: ReadonlySet<string> = new Set([
  '@microsoft/fabric-user-data-functions',
]);

/** Default trust predicate. Auto-trusts the Microsoft Rayfin namespace. */
export const defaultTrust: TrustPredicate = (packageName) =>
  packageName.startsWith('@microsoft/rayfin-') ||
  TRUSTED_NON_RAYFIN_PACKAGES.has(packageName);

/**
 * Inputs to the package-discovery routine. Callers must choose exactly one
 * discovery source: `candidates` to probe a fixed catalog list,
 * `packageRoots` for explicit workspace package folders, or
 * `scanInstalledPackages: true` to walk all packages under ancestor
 * `node_modules` directories.
 */
export interface DiscoveryOptions {
  /**
   * Module identifier or directory used as the resolution base. The
   * walker calls `createRequire(from).resolve('<pkg>/package.json')`
   * to locate each candidate. Pass `import.meta.url` from the consuming
   * module, or a directory path that exists in the project.
   */
  from: string;
  /**
   * Optional candidate package names to probe for `rayfinDocs`.
   * An empty array is still an explicit source and returns no packages.
   */
  candidates?: readonly string[];
  /**
   * Optional explicit package roots to inspect. Used by in-repo tooling such
   * as the Docusaurus site where package docs are read directly from workspace
   * package folders instead of an installed `node_modules` tree. An empty
   * array is still an explicit source and returns no packages.
   */
  packageRoots?: readonly string[];
  /**
   * Explicit opt-in for scanning every installed package under the nearest
   * `node_modules` chain. Prefer `candidates` for CLI/MCP agent paths so
   * discovery stays bounded to the Rayfin package catalog.
   */
  scanInstalledPackages?: boolean;
  /** Trust predicate; defaults to {@link defaultTrust}. */
  trust?: TrustPredicate;
}

/**
 * Returns whether callers already selected a discovery source.
 * Wrappers use this to decide whether to inject their own bounded defaults.
 */
export function hasExplicitDiscoverySource(options: DiscoveryOptions): boolean {
  return countDiscoverySources(options) > 0;
}

/**
 * Resolve each candidate package's `package.json`, validate the
 * `rayfinDocs` field, and return discovered packages.
 *
 * Untrusted packages (per {@link TrustPredicate}) are skipped with a
 * structured `untrustedSkipped` entry so callers can surface the skip.
 * Packages that fail manifest validation produce a structured
 * `invalidManifest` entry rather than throwing - discovery is
 * defensive: a single broken package shouldn't crash the indexer.
 */
export interface DiscoveryResult {
  discovered: DiscoveredPackage[];
  notInstalled: string[];
  untrustedSkipped: string[];
  invalidManifest: Array<{ packageName: string; reason: string }>;
}

export function discoverRayfinDocsPackages(
  options: DiscoveryOptions
): DiscoveryResult {
  const trust = options.trust ?? defaultTrust;
  const fromDir =
    options.from.startsWith('file:') || options.from.includes('://')
      ? dirname(fileURLToPath(options.from))
      : resolveExistingDir(options.from);
  const nodeModulesChain = buildNodeModulesChain(fromDir);

  const discovered: DiscoveredPackage[] = [];
  const notInstalled: string[] = [];
  const untrustedSkipped: string[] = [];
  const invalidManifest: Array<{ packageName: string; reason: string }> = [];

  const sourceCount = countDiscoverySources(options);
  if (sourceCount === 0) {
    throw new Error(
      'discoverRayfinDocsPackages requires an explicit source: pass `candidates`, `packageRoots`, or `scanInstalledPackages: true`.'
    );
  }
  if (sourceCount > 1) {
    throw new Error(
      'discoverRayfinDocsPackages requires exactly one explicit source: pass only one of `candidates`, `packageRoots`, or `scanInstalledPackages: true`.'
    );
  }

  let packagesToRead: Array<{ packageName: string; pkgJsonPath: string }>;
  if (options.packageRoots !== undefined) {
    packagesToRead = resolvePackageRootJsons(options.packageRoots);
  } else if (options.candidates !== undefined) {
    packagesToRead = resolveCandidatePackageJsons(
      options.candidates,
      fromDir,
      notInstalled,
      untrustedSkipped,
      trust
    );
  } else if (options.scanInstalledPackages) {
    packagesToRead = discoverInstalledPackageJsons(nodeModulesChain);
  } else {
    throw new Error(
      'Invariant violation: explicit discovery source count did not match selected source.'
    );
  }

  for (const { packageName: candidate, pkgJsonPath } of packagesToRead) {
    let pkgJson: unknown;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch (err) {
      invalidManifest.push({
        packageName: candidate,
        reason: `unreadable package.json: ${(err as Error).message}`,
      });
      continue;
    }

    const parsedName = (pkgJson as { name?: unknown } | null)?.name;
    const packageName = typeof parsedName === 'string' ? parsedName : candidate;
    const hasRayfinDocs =
      typeof pkgJson === 'object' &&
      pkgJson !== null &&
      'rayfinDocs' in pkgJson;
    if (!hasRayfinDocs) {
      continue;
    }
    const parsedVersion = (pkgJson as { version?: unknown } | null)?.version;
    if (typeof parsedVersion !== 'string' || parsedVersion.length === 0) {
      invalidManifest.push({
        packageName,
        reason:
          'package.json must declare a non-empty string version when rayfinDocs is present',
      });
      continue;
    }
    if (!trust(packageName)) {
      untrustedSkipped.push(packageName);
      continue;
    }
    const validation = validateRayfinDocsManifest(pkgJson, candidate);
    if (!validation.ok) {
      if (validation.kind === 'missing') {
        // Package is installed but doesn't declare rayfinDocs. This is
        // not an error - it's the common case for any package that
        // hasn't migrated yet. Don't surface as invalid.
        continue;
      }
      invalidManifest.push({
        packageName: candidate,
        reason: validation.reason,
      });
      continue;
    }

    const packageRoot = dirname(pkgJsonPath);
    discovered.push({
      packageName,
      packageVersion: parsedVersion,
      packageRoot,
      manifest: validation.manifest,
    });
  }

  return { discovered, notInstalled, untrustedSkipped, invalidManifest };
}

function countDiscoverySources(options: DiscoveryOptions): number {
  return [
    options.packageRoots !== undefined,
    options.candidates !== undefined,
    options.scanInstalledPackages === true,
  ].filter(Boolean).length;
}

function resolvePackageRootJsons(
  packageRoots: readonly string[]
): Array<{ packageName: string; pkgJsonPath: string }> {
  return packageRoots.map((packageRoot) => ({
    packageName: packageRoot,
    pkgJsonPath: join(resolveExistingDir(packageRoot), 'package.json'),
  }));
}

/**
 * Resolve explicitly named candidates. Direct-only by construction: docs
 * discovery reports packages the caller named and trusts, so it must not reach
 * through the dependency graph into packages nobody asked about.
 */
function resolveCandidatePackageJsons(
  candidates: readonly string[],
  fromDir: string,
  notInstalled: string[],
  untrustedSkipped: string[],
  trust: TrustPredicate
): Array<{ packageName: string; pkgJsonPath: string }> {
  const resolved: Array<{ packageName: string; pkgJsonPath: string }> = [];
  for (const candidate of candidates) {
    if (!trust(candidate)) {
      untrustedSkipped.push(candidate);
      continue;
    }
    const pkgJsonPath = resolvePackageJsonFrom(fromDir, candidate);
    if (!pkgJsonPath) {
      notInstalled.push(candidate);
      continue;
    }
    resolved.push({ packageName: candidate, pkgJsonPath });
  }
  return resolved;
}

function discoverInstalledPackageJsons(
  nodeModulesChain: readonly string[]
): Array<{ packageName: string; pkgJsonPath: string }> {
  const discovered: Array<{ packageName: string; pkgJsonPath: string }> = [];
  const seen = new Set<string>();

  for (const dir of nodeModulesChain) {
    const nodeModules = join(dir, 'node_modules');
    if (!existsSync(nodeModules) || !statSync(nodeModules).isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      if (entry.name.startsWith('@')) {
        const scopeRoot = join(nodeModules, entry.name);
        for (const scoped of readdirSync(scopeRoot, { withFileTypes: true })) {
          if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
          const packageName = `${entry.name}/${scoped.name}`;
          const pkgJsonPath = join(scopeRoot, scoped.name, 'package.json');
          if (!seen.has(packageName) && existsSync(pkgJsonPath)) {
            seen.add(packageName);
            discovered.push({ packageName, pkgJsonPath });
          }
        }
      } else {
        const packageName = entry.name;
        const pkgJsonPath = join(nodeModules, entry.name, 'package.json');
        if (!seen.has(packageName) && existsSync(pkgJsonPath)) {
          seen.add(packageName);
          discovered.push({ packageName, pkgJsonPath });
        }
      }
    }
  }

  return discovered;
}

export type ManifestValidation =
  | { ok: true; manifest: RayfinDocsManifest }
  | { ok: false; kind: 'missing' }
  | { ok: false; kind: 'invalid'; reason: string };

/**
 * Validate the `rayfinDocs` field on a parsed `package.json`. Returns
 * a discriminated result so callers can distinguish "no manifest"
 * (silently skip) from "broken manifest" (surface as warning).
 *
 * Path validation rejects absolute paths and parent-directory
 * traversal in `dir` - discovered packages must keep their docs
 * inside their own root.
 */
export function validateRayfinDocsManifest(
  pkgJson: unknown,
  packageName: string
): ManifestValidation {
  if (!pkgJson || typeof pkgJson !== 'object') {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'package.json is not an object',
    };
  }
  const rec = pkgJson as Record<string, unknown>;
  const raw = rec['rayfinDocs'];
  if (raw === undefined) {
    return { ok: false, kind: 'missing' };
  }
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      kind: 'invalid',
      reason: '`rayfinDocs` field is not an object',
    };
  }
  const m = raw as Record<string, unknown>;
  if (m['version'] !== 1) {
    return {
      ok: false,
      kind: 'invalid',
      reason: `unsupported rayfinDocs.version (got ${JSON.stringify(m['version'])}, expected 1); skipping ${packageName}`,
    };
  }
  if (m['dir'] !== undefined && typeof m['dir'] !== 'string') {
    return {
      ok: false,
      kind: 'invalid',
      reason: '`rayfinDocs.dir` must be a non-empty string',
    };
  }
  if (m['dir'] === '') {
    return {
      ok: false,
      kind: 'invalid',
      reason: '`rayfinDocs.dir` must be a non-empty string',
    };
  }
  const dir = m['dir'] ?? 'assets/docs';
  if (isAbsolute(dir)) {
    return {
      ok: false,
      kind: 'invalid',
      reason:
        '`rayfinDocs.dir` must be a relative path inside the package root',
    };
  }
  // Reject `..` segments anywhere in the relative path. Segment-based
  // check uniformly handles `..`, `./..`, `docs/..`, `a/../b`, and
  // mixed separators.
  const normalized = dir.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '..')) {
    return {
      ok: false,
      kind: 'invalid',
      reason:
        '`rayfinDocs.dir` must not traverse outside the package root (no `..` segments)',
    };
  }
  if (typeof m['module'] !== 'string' || m['module'].length === 0) {
    return {
      ok: false,
      kind: 'invalid',
      reason: '`rayfinDocs.module` must be a non-empty string',
    };
  }
  if (
    m['kind'] !== 'guide' &&
    m['kind'] !== 'host' &&
    m['kind'] !== 'api-reference'
  ) {
    return {
      ok: false,
      kind: 'invalid',
      reason:
        `\`rayfinDocs.kind\` must be one of "guide" | "host" | "api-reference" (got ${JSON.stringify(m['kind'])}). ` +
        `If you need a new kind, request it in the rayfin-docs repo: ` +
        `https://github.com/microsoft/project-rayfin/issues/new`,
    };
  }
  return {
    ok: true,
    manifest: {
      version: 1,
      dir,
      module: m['module'],
      kind: m['kind'] as DocKind,
    },
  };
}

/**
 * Map a `DocKind` to the legacy `DocModule` value used throughout the
 * existing CLI/MCP surfaces. Phase 2 keeps the `DocModule` union for
 * back-compat; `--module ts-sdk` continues to mean "all api-reference
 * docs" for end users.
 */
export function docKindToModule(kind: DocKind): 'guide' | 'host' | 'ts-sdk' {
  switch (kind) {
    case 'guide':
      return 'guide';
    case 'host':
      return 'host';
    case 'api-reference':
      return 'ts-sdk';
  }
}

/**
 * Compute the chain of `node_modules` ancestor directories from
 * `fromDir` upward, capped at 16 levels. Used by the ancestor tier in
 * {@link resolvePackageJsonFrom} to avoid re-walking the same ancestors
 * once per candidate (`9 candidates × 16 walks = 144 stat calls` in
 * the original implementation; this caches the chain to 16 stats).
 */
function buildNodeModulesChain(fromDir: string): string[] {
  const chain: string[] = [];
  let dir = fromDir;
  for (let i = 0; i < 16; i += 1) {
    chain.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

/**
 * Dependency fields that describe packages actually present in an install.
 *
 * `devDependencies` is deliberately excluded: it is not installed for a
 * transitive dependency, so following it would walk edges that do not exist in
 * the consuming project's tree.
 */
const INSTALLED_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * Bounds on the dependency-graph search. The walk only runs for a package the
 * direct tiers already failed to find, so these cap a rare path rather than the
 * common one.
 */
const MAX_TRANSITIVE_DEPTH = 4;
const MAX_TRANSITIVE_VISITS = 256;

/** One package and its actual installed manifest version. */
export interface InstalledPackageVersion {
  name: string;
  version: string;
}

/** Installed package versions plus candidates that could not be resolved. */
export interface InstalledPackageVersionResolution {
  packages: InstalledPackageVersion[];
  unresolvedPackageNames: string[];
}

/** Optional policy applied to installed manifest versions. */
export interface InstalledPackageVersionResolutionOptions {
  isVersionAllowed?: (version: string) => boolean;
  /**
   * Also resolve packages that are installed but reachable only as an *indirect*
   * dependency — one a strict/isolated install links inside its dependent's
   * scope rather than anywhere `from` can see (see
   * {@link resolvePackageJsonTransitively}).
   *
   * Off by default
   */
  includeIndirect?: boolean;
}

/**
 * Resolve actual installed versions for a bounded candidate set.
 *
 * Candidates are deduplicated and sorted. Missing, malformed, or mismatched
 * manifests are omitted so telemetry collection remains best-effort.
 *
 * Resolves only what `from` can reach unless `includeIndirect` is set.
 */
export function resolveInstalledPackageVersions(
  packageNames: readonly string[],
  from: string,
  options: InstalledPackageVersionResolutionOptions = {}
): InstalledPackageVersionResolution {
  const fromDir =
    from.startsWith('file:') || from.includes('://')
      ? dirname(fileURLToPath(from))
      : resolveExistingDir(from);
  const packages: InstalledPackageVersion[] = [];
  const unresolvedPackageNames: string[] = [];

  for (const packageName of [...new Set(packageNames)].sort()) {
    if (!isValidPackageName(packageName)) {
      unresolvedPackageNames.push(packageName);
      continue;
    }
    const packageJsonPath =
      resolvePackageJsonFrom(fromDir, packageName) ??
      (options.includeIndirect
        ? resolvePackageJsonTransitively(fromDir, packageName)
        : undefined);
    if (!packageJsonPath) {
      unresolvedPackageNames.push(packageName);
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        manifest.name === packageName &&
        typeof manifest.version === 'string' &&
        manifest.version.length > 0 &&
        (options.isVersionAllowed?.(manifest.version) ?? true)
      ) {
        packages.push({ name: packageName, version: manifest.version });
      } else {
        unresolvedPackageNames.push(packageName);
      }
    } catch {
      unresolvedPackageNames.push(packageName);
    }
  }
  return { packages, unresolvedPackageNames };
}

function isValidPackageName(packageName: string): boolean {
  return (
    packageName.length <= 214 &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)
  );
}

/**
 * Find a package's `package.json` **as resolved from `fromDir`**, even when
 * exports hide it, the package is ESM-only, or the install is hoisted above the
 * resolution root.
 *
 * Packages with restricted exports often omit `./package.json`, causing direct
 * subpath resolution to fail. ESM-only packages may also hide their main entry
 * from CommonJS resolution, so the final tier searches the ancestor
 * `node_modules` chain used by npm, pnpm, and Yarn-style installs.
 *
 * Scoped to one directory so the dependency-graph walk can reuse it verbatim:
 * "resolve X from package Y's location" is the same question as "resolve X from
 * the project root", just asked somewhere else in the tree.
 */
function resolvePackageJsonFrom(
  fromDir: string,
  packageName: string
): string | undefined {
  const req = createRequire(join(fromDir, 'noop.js'));

  // Tier 1: direct manifest resolution when exports allow the subpath.
  try {
    return req.resolve(`${packageName}/package.json`);
  } catch {
    // MODULE_NOT_FOUND means only this subpath failed to resolve, not that the
    // package is absent. Restricted exports and alternate layouts require the
    // remaining tiers.
  }

  // Tier 2: resolve the package entry, then walk upward to its named manifest.
  try {
    const entry = req.resolve(packageName);
    let dir = dirname(entry);
    for (let i = 0; i < 16; i += 1) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        try {
          const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
            name?: string;
          };
          if (parsed.name === packageName) return candidate;
        } catch {
          // Keep walking toward the package root.
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ESM-only package or similar: fall through to node_modules lookup.
  }

  // Tier 3: search ancestor node_modules roots, independent of exports.
  for (const dir of buildNodeModulesChain(fromDir)) {
    const candidate = join(dir, 'node_modules', packageName, 'package.json');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Find a package that is installed but *not reachable from `fromDir`* by
 * searching outward through the dependency graph.
 *
 * A strict/isolated install (pnpm's default, and Yarn's `nmMode: hardlinks`)
 * links a purely transitive package only inside the dependency scope of the
 * package that asked for it — never the consumer's own `node_modules` chain.
 * Resolution from `fromDir` therefore fails for it, correctly: nothing at the
 * project root may import it. It is still the version that ships, because the
 * bundler reaches it through the dependent that does.
 *
 * So the search moves to where the answer is: walk the installed dependency
 * graph breadth-first and re-ask {@link resolvePackageJsonFrom} at each package's
 * own real location. Node's resolver supplies all the layout knowledge —
 * following the symlink out of pnpm's virtual store and then finding the target
 * as its sibling — instead of this code hard-coding store paths, and it costs
 * nothing on the common path because it only runs after a direct miss.
 *
 * Known limitation: Yarn Plug'n'Play has no `node_modules` tree at all, so
 * neither this nor the direct tiers can see it without the `.pnp.cjs` API.
 */
function resolvePackageJsonTransitively(
  fromDir: string,
  packageName: string
): string | undefined {
  const visited = new Set<string>();
  let frontier = readInstalledDependencyNames(join(fromDir, 'package.json'));
  // Not seeded from the manifest alone: a project whose own manifest is
  // unreadable can still have an installed tree worth searching.
  if (frontier.length === 0) {
    frontier = readAncestorNodeModulesEntries(fromDir);
  }

  for (let depth = 0; depth < MAX_TRANSITIVE_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const dependentName of frontier) {
      if (visited.size >= MAX_TRANSITIVE_VISITS) return undefined;
      if (dependentName === packageName) continue;
      if (visited.has(dependentName)) continue;
      visited.add(dependentName);
      if (!isValidPackageName(dependentName)) continue;

      const dependentManifest = resolvePackageJsonFrom(fromDir, dependentName);
      if (!dependentManifest) continue;

      // The real location matters: resolving through the virtual-store symlink
      // is what puts the target in scope as a sibling.
      let dependentDir: string;
      try {
        dependentDir = realpathSync(dirname(dependentManifest));
      } catch {
        continue;
      }

      const found = resolvePackageJsonFrom(dependentDir, packageName);
      if (found) return found;

      next.push(
        ...readInstalledDependencyNames(join(dependentDir, 'package.json'))
      );
    }
    if (next.length === 0) return undefined;
    frontier = next;
  }
  return undefined;
}

/** Names declared in the dependency fields that describe an installed tree. */
function readInstalledDependencyNames(manifestPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const names: string[] = [];
    for (const field of INSTALLED_DEPENDENCY_FIELDS) {
      const value = parsed[field];
      if (value && typeof value === 'object') {
        names.push(...Object.keys(value as Record<string, unknown>));
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Top-level package names installed in the nearest ancestor `node_modules`,
 * used to seed the graph walk when no readable manifest declares anything.
 */
function readAncestorNodeModulesEntries(fromDir: string): string[] {
  for (const dir of buildNodeModulesChain(fromDir)) {
    const nodeModules = join(dir, 'node_modules');
    if (!existsSync(nodeModules)) continue;
    try {
      const names: string[] = [];
      for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name.startsWith('@')) {
          const scopeDir = join(nodeModules, entry.name);
          for (const scoped of readdirSync(scopeDir)) {
            names.push(`${entry.name}/${scoped}`);
          }
          continue;
        }
        names.push(entry.name);
      }
      return names;
    } catch {
      return [];
    }
  }
  return [];
}

/** Internal: ensure `from` exists for `createRequire` when given a dir. */
function resolveExistingDir(from: string): string {
  const absolute = resolve(from);
  if (!existsSync(absolute)) {
    throw new Error(
      `discoverRayfinDocsPackages: \`from\` path does not exist: ${absolute}`
    );
  }
  const st = statSync(absolute);
  if (!st.isDirectory()) {
    throw new Error(
      `discoverRayfinDocsPackages: \`from\` must be a directory: ${absolute}`
    );
  }
  return absolute;
}
