export type DocModule = 'guide' | 'host' | 'ts-sdk';

export type DocKind = 'guide' | 'host' | 'api-reference';

export type DocSearchScope = 'docs' | 'symbols' | 'all';

/**
 * `rayfinDocs` package.json field declaring where a package's docs live
 * and what kind they are. Read by the discovery walker; the manifest
 * is per-package and points at a single doc tree.
 */
export interface RayfinDocsManifest {
  version: 1;
  /** Path to the docs root, relative to package.json's directory. */
  dir: string;
  /** Stable, human-readable module identity. Conventionally the
   *  unscoped package name (e.g. `rayfin-core`, `rayfin-guide`,
   *  `rayfin-host`). */
  module: string;
  /** Doc kind. Maps to the legacy `DocModule` for back-compat:
   *  - `guide` → `module: guide`
   *  - `host` → `module: host`
   *  - `api-reference` → `module: ts-sdk` */
  kind: DocKind;
}

export interface DocSection {
  heading: string;
  level: number;
  content: string;
  symbols: string[];
}

export interface DocEntry {
  id: string;
  module: DocModule;
  path: string;
  title: string;
  content: string;
  symbols: string[];
  sections: DocSection[];
  /** When this entry came from a discovered package (Phase 2+), the
   *  identifying package metadata. `undefined` for entries loaded from
   *  the bundled `assetsRoot` (Phase 1 mode). */
  source?: DocSource;
}

export interface DocSource {
  /** Manifest module identity (e.g. `rayfin-core`). */
  module: string;
  /** Doc kind from the manifest. */
  kind: DocKind;
  /** Package name from the manifest's `package.json` (e.g.
   *  `@microsoft/rayfin-core`). The package's filesystem path is
   *  intentionally NOT exposed in this public type — it leaks the
   *  user's home directory into MCP/CLI output. Internal callers that
   *  need the absolute path use the `DiscoveredPackage.packageRoot`
   *  field on the discovery report instead. */
  packageName: string;
  /** Version from the source package's `package.json`. */
  packageVersion: string;
}

export interface DocListItem {
  id: string;
  module: DocModule;
  path: string;
  title: string;
  source?: DocSource;
}

export interface DocSearchResult {
  id: string;
  module: DocModule;
  path: string;
  title: string;
  heading?: string;
  symbol?: string;
  kind?: 'doc' | 'symbol';
  snippet: string;
  snippetStart: number;
  snippetEnd: number;
  score: number;
  symbols: string[];
  source?: DocSource;
}

export interface DocSectionRef {
  symbol: string;
  entryId: string;
  module: DocModule;
  path: string;
  title: string;
  heading: string;
  content: string;
  source?: DocSource;
}
