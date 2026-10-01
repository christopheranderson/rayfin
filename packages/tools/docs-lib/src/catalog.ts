/**
 * Catalog of known Rayfin packages - what exists, what each does, how
 * to install. Lives in `@microsoft/rayfin-docs` alongside the indexer
 * because catalog updates and indexer changes share the same trigger
 * ("we shipped a new SDK package"); splitting them across packages
 * just multiplies release coordination overhead.
 *
 * - {@link getCatalog} returns the static manifest (cached, frozen).
 * - {@link discoverPackages} ranks catalog packages by query relevance —
 *   used to power `rayfin docs discover <query>` and the MCP
 *   `discover_packages` tool when an agent's search through the
 *   installed corpus comes up empty or the installed package version
 *   appears too old to contain the requested feature.
 *
 * The catalog ships as a static JSON file inside this package's
 * `assets/` directory. Updates are rolled out as `rayfin-docs` version
 * bumps - there is no hosted-endpoint refresh path.
 */
export type {
  Catalog,
  CatalogPackage,
  CatalogPackageKind,
  CatalogPackageStability,
} from './catalog-types.js';

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import type {
  Catalog,
  CatalogPackage,
  CatalogPackageKind,
} from './catalog-types.js';

/**
 * Read the static catalog JSON shipped inside this package's `assets/`
 * directory. `import.meta.url` after compile points at `dist/catalog.js`;
 * `assets/catalog.json` lives one level up at the package root.
 *
 * Loaded once per process and cached for the lifetime of the process.
 */
let catalogCache: Catalog | undefined;
function loadCatalog(): Catalog {
  if (catalogCache) return catalogCache;
  const path = fileURLToPath(
    new URL('../assets/catalog.json', import.meta.url)
  );
  const raw = readFileSync(path, 'utf8');
  catalogCache = JSON.parse(raw) as Catalog;
  return catalogCache;
}

const CATALOG_SCHEMA_VERSION = 1;

/**
 * Return the static catalog as shipped by this package version. The
 * returned object is the package's own data - frozen so consumers
 * can't mutate the in-memory copy.
 */
let frozenCatalog: Catalog | undefined;
export function getCatalog(): Catalog {
  if (!frozenCatalog) {
    const data = loadCatalog();
    frozenCatalog = freezeCatalog(data);
  }
  return frozenCatalog;
}

/**
 * Reset the in-memory catalog cache so the next `getCatalog()` re-reads
 * the bundled JSON. Test-only export.
 */
export function _resetCatalogForTesting(): void {
  frozenCatalog = undefined;
  catalogCache = undefined;
}

function freezeCatalog(data: Catalog): Catalog {
  const schemaVersion = (data as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error('Unsupported Rayfin docs catalog schema version.');
  }

  // Deep freeze on first read. Defensive copy of the embedded JSON so
  // package consumers can't reach in and mutate the singleton.
  const copy: Catalog = {
    schemaVersion: data.schemaVersion,
    generatedAt: data.generatedAt,
    packages: data.packages.map((p) => ({
      ...p,
      topics: [...p.topics],
      modules: [...p.modules],
    })),
  };
  Object.freeze(copy);
  Object.freeze(copy.packages);
  for (const p of copy.packages) {
    Object.freeze(p);
    Object.freeze(p.topics);
    Object.freeze(p.modules);
  }
  return copy;
}

/** Ranking signal score breakdown - exposed for tests + diagnostics. */
export interface DiscoverScore {
  package: CatalogPackage;
  score: number;
  /** Which fields contributed. Useful for "why did this match?" UX. */
  matchedOn: Array<'name' | 'summary' | 'topics' | 'kind'>;
}

/**
 * Rank catalog packages by query relevance. Used by CLI/MCP discover
 * surfaces. Scoring (deterministic, no embedding):
 *
 * - **name** exact substring match: +5
 * - **kind** exact match (e.g. query "sdk"): +3
 * - **topic** word match: +2 per matching topic
 * - **summary** word match: +1 per matching token
 *
 * Returns scored packages sorted descending by score; ties broken by
 * alphabetical package name. Packages with score 0 are excluded.
 * SDK catalog-only entries with no docs modules are also excluded so
 * discover results never recommend installing an SDK package that cannot
 * contribute searchable docs yet. Packages marked
 * `stability: 'experimental'` are excluded for the same reason — they
 * stay in the catalog so their docs are still discovered once installed,
 * but they are never surfaced as an install recommendation.
 *
 * Stop-words and tokens shorter than 3 chars are ignored to keep the
 * signal-to-noise ratio high - the rare "auth" 4-char query still
 * matches because tokenization is on word boundaries, but "is"/"a"
 * never match.
 */
export function discoverPackages(
  query: string,
  catalog: Catalog = getCatalog()
): DiscoverScore[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const queryLower = query.toLowerCase().trim();
  const scored: DiscoverScore[] = [];

  for (const pkg of catalog.packages) {
    if (pkg.kind === 'sdk' && pkg.modules.length === 0) {
      continue;
    }
    if (pkg.stability === 'experimental') {
      continue;
    }

    let score = 0;
    const matchedOn: DiscoverScore['matchedOn'] = [];

    // Name substring match - strongest signal
    const nameLower = pkg.name.toLowerCase();
    if (nameLower.includes(queryLower)) {
      score += 5;
      matchedOn.push('name');
    } else {
      // Word-by-word match on name (e.g. query "auth fabric" matches
      // `@microsoft/rayfin-auth-provider-fabric`)
      for (const token of tokens) {
        if (nameLower.includes(token)) {
          score += 2;
          if (!matchedOn.includes('name')) matchedOn.push('name');
        }
      }
    }

    // Kind match
    if (tokens.includes(pkg.kind)) {
      score += 3;
      matchedOn.push('kind');
    }

    // Topic match - strong signal because topics are curated
    for (const topic of pkg.topics) {
      const topicLower = topic.toLowerCase();
      if (tokens.includes(topicLower)) {
        score += 2;
        if (!matchedOn.includes('topics')) matchedOn.push('topics');
      } else {
        // Partial topic match (substring) - weaker signal
        for (const token of tokens) {
          if (token.length >= 4 && topicLower.includes(token)) {
            score += 1;
            if (!matchedOn.includes('topics')) matchedOn.push('topics');
          }
        }
      }
    }

    // Summary word match - weakest signal
    const summaryTokens = tokenize(pkg.summary);
    for (const token of tokens) {
      if (summaryTokens.includes(token)) {
        score += 1;
        if (!matchedOn.includes('summary')) matchedOn.push('summary');
      }
    }

    if (score > 0) {
      scored.push({ package: pkg, score, matchedOn });
    }
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.package.name.localeCompare(b.package.name);
  });
  return scored;
}

/** Wire-shape item returned by both the CLI `rayfin docs discover --json`
 *  and the MCP `discover_packages` tool. Defined here so the two
 *  surfaces stay in lockstep - adding a field once updates both. */
export interface DiscoverItem {
  name: string;
  kind: CatalogPackageKind;
  summary: string;
  topics: string[];
  installCommand: string;
  updateCommand: string;
  versionLockedDocs: string;
  homepageUrl?: string;
  score: number;
  matchedOn: Array<'name' | 'summary' | 'topics' | 'kind'>;
}

/** Map a {@link DiscoverScore} to the wire shape consumed by both
 *  CLI and MCP. Defensive copies of array fields ensure consumers
 *  can't mutate the catalog singleton's frozen inner arrays via the
 *  result. */
export function mapDiscoverResult(score: DiscoverScore): DiscoverItem {
  const item: DiscoverItem = {
    name: score.package.name,
    kind: score.package.kind,
    summary: score.package.summary,
    topics: [...score.package.topics],
    installCommand: deriveInstallCommand(score.package),
    updateCommand: deriveUpdateCommand(score.package),
    versionLockedDocs:
      'Docs are served from the package version installed in the current project. If this package is already installed but the feature is missing from search results, upgrade the package and re-run the docs query.',
    score: score.score,
    matchedOn: [...score.matchedOn],
  };
  if (score.package.homepageUrl) {
    item.homepageUrl = score.package.homepageUrl;
  }
  return item;
}

/** Derive an install command for a catalog package. Defaults to
 * `npm install <name>` unless the catalog entry specifies an
 * `installCommand` override (e.g. `npm create rayfin@latest`).
 */
export function deriveInstallCommand(pkg: CatalogPackage): string {
  if (pkg.installCommand) return pkg.installCommand;
  if (pkg.name === '@microsoft/create-rayfin') {
    return 'npm create rayfin@latest';
  }
  return `npm install ${pkg.name}`;
}

/** Derive an update command for a catalog package. Agents surface this
 * when the package is already installed but version-locked docs do not
 * contain the requested feature.
 */
export function deriveUpdateCommand(pkg: CatalogPackage): string {
  if (pkg.updateCommand) return pkg.updateCommand;
  if (pkg.name === '@microsoft/create-rayfin') {
    return 'npm create rayfin@latest';
  }
  return `npm install ${pkg.name}@latest`;
}

const STOPWORDS = new Set([
  'and',
  'the',
  'for',
  'with',
  'how',
  'what',
  'when',
  'where',
  'this',
  'that',
  'from',
  'into',
  'onto',
  'use',
  'using',
]);

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}
