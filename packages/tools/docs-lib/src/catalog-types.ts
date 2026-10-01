/**
 * Bundled static manifest of Rayfin packages.
 *
 * Shipped inside `@microsoft/rayfin-docs` to power:
 * - `rayfin docs discover <query>` (CLI)
 * - the `discover_packages` MCP tool
 *
 * The catalog answers "what packages exist, what could I install, and
 * what should I update if the installed docs do not include a feature?"
 * It is INTENTIONALLY decoupled from runtime discovery (which only sees
 * what's installed in `node_modules`). The two compose: the agent first
 * checks installed packages via `DocsService.searchDocs(...)`, and if
 * nothing relevant comes back, falls through to `discoverPackages(query)`
 * to surface install recommendations.
 *
 * Phase 4 of the `docs-package-architecture` migration. The catalog
 * shape is hand-curated and bundled with `@microsoft/rayfin-docs`;
 * updates ship as `rayfin-docs` version bumps (no hosted endpoint).
 */

export type CatalogPackageKind =
  | 'sdk'
  | 'tool'
  | 'guide'
  | 'host'
  | 'sample'
  | 'external';

/**
 * Release stability of a catalog package.
 *
 * - `stable` — on the supported public surface; safe to recommend.
 * - `experimental` — ships, but its API may change or be removed without
 *   a major-version bump. Present in the catalog so its docs are still
 *   discovered and searchable once installed, but never recommended by
 *   `discoverPackages(query)`.
 */
export type CatalogPackageStability = 'stable' | 'experimental';

/** A single entry in the catalog. */
export interface CatalogPackage {
  /** Full npm name (e.g. `@microsoft/rayfin-core`). */
  name: string;
  /** Kind, used to group results in CLI/MCP surfaces. */
  kind: CatalogPackageKind;
  /**
   * Release stability. Defaults to `stable` when omitted.
   *
   * Experimental packages stay in the catalog so
   * `getKnownRayfinDocsPackages()` still probes them for the `rayfinDocs`
   * field — their docs remain listable and searchable once installed —
   * but {@link discoverPackages} filters them out so install
   * recommendations never point at an unsupported surface.
   */
  stability?: CatalogPackageStability;
  /** One-line summary surfaced in discover results. */
  summary: string;
  /** Searchable topics - used by the relevance scorer in
   *  `discoverPackages(query)`. Should be lowercased. */
  topics: string[];
  /** Doc modules this package contributes when installed. Mirrors the
   *  `rayfinDocs.module` field on the package itself. Empty when the
   *  package doesn't ship docs yet; SDK entries with no modules are
   *  kept for package awareness but are omitted from discover results. */
  modules: string[];
  /** Optional homepage URL - defaults to the npm page. */
  homepageUrl?: string;
  /** Optional install command override - defaults to `npm install <name>`. */
  installCommand?: string;
  /** Optional update command override - defaults to `npm install <name>@latest`. */
  updateCommand?: string;
}

export interface Catalog {
  schemaVersion: 1;
  /** ISO-8601 timestamp when this catalog was last regenerated. Used by
   *  consumers to display a "catalog generated YYYY-MM-DD" footer when
   *  `rayfin docs catalog show` is invoked. */
  generatedAt: string;
  packages: CatalogPackage[];
}
