## ADDED Requirements

### Requirement: Library Package

The Rayfin docs indexing logic SHALL be exposed as a standalone library package `@microsoft/rayfin-docs` that
contains pure code (no bundled docs content). Every Rayfin doc-facing surface (MCP server, CLI, future
extensions) SHALL consume this library to access docs functionality, rather than each surface re-implementing
loading or search.

#### Scenario: Single backend across surfaces
- **WHEN** the MCP server (`@microsoft/rayfin-mcp`) and the CLI (`@microsoft/rayfin-cli`) both want to expose
  docs to an agent
- **THEN** both packages SHALL import `DocsService` from `@microsoft/rayfin-docs`
- **AND** the library SHALL expose `DocsService`, `PackageDiscovery`, `SearchIndex`, `SymbolResolver`, and
  `CatalogResolver` as its public surface

#### Scenario: No bundled content
- **WHEN** a consumer installs `@microsoft/rayfin-docs`
- **THEN** the package's tarball SHALL NOT contain any markdown docs or pre-built search indexes
- **AND** the library SHALL discover and index docs at runtime from packages declaring the `rayfinDocs` field

#### Scenario: Thin surfaces
- **WHEN** `@microsoft/rayfin-mcp` or `@microsoft/rayfin-cli` serves docs
- **THEN** it SHALL construct `DocsService` from `@microsoft/rayfin-docs`
- **AND** it SHALL NOT read a copied docs corpus from `@microsoft/rayfin-mcp/assets/docs`
- **AND** it SHALL NOT serve docs whose version is coupled to the MCP or CLI package rather than the user's
  installed Rayfin packages

### Requirement: Package Discovery

The library SHALL discover docs by probing known Rayfin packages or by walking the consumer's installed packages
(`node_modules`) and finding every package whose `package.json` declares a `rayfinDocs` field.

#### Scenario: Unbounded discovery
- **WHEN** a consumer calls `PackageDiscovery.discover(rootDir)` without a candidate package list
- **THEN** the library SHALL walk from `rootDir` to find the nearest `node_modules/`
- **AND** it SHALL iterate every package directory and load each `package.json`
- **AND** for packages with a `rayfinDocs` field, it SHALL validate the field and add the package to the
  discovered set
- **AND** it SHALL return discovered packages with package name, package version, package root, module, and kind

#### Scenario: Bounded catalog-candidate discovery
- **WHEN** `DocsService` discovers installed docs without an explicit candidate list or explicit package roots
- **THEN** it SHALL default to the known Rayfin docs package candidate list from `@microsoft/rayfin-docs`
- **AND** it SHALL probe only those candidates instead of walking unrelated `node_modules` packages
- **AND** missing candidates SHALL be reported as not installed rather than treated as errors

#### Scenario: Workspace package-root discovery
- **WHEN** in-repo tooling such as the Docusaurus site needs to render workspace package docs
- **THEN** the library SHALL support explicit package roots in addition to installed `node_modules` discovery
- **AND** it SHALL validate the same `rayfinDocs` field before exposing those docs to the caller

### Requirement: Version-Locked Docs

The library SHALL serve documentation from the exact Rayfin package versions installed in the user's project,
so agents do not describe APIs or features that are unavailable to the current application.

#### Scenario: Installed package version controls available docs
- **GIVEN** a project has `@microsoft/rayfin-core@1.20.0` installed
- **AND** `@microsoft/rayfin-core@1.26.0` documents a newer decorator that does not exist in `1.20.0`
- **WHEN** an agent calls `search_docs` through MCP or `rayfin docs search` through the CLI
- **THEN** the docs index SHALL be built from `@microsoft/rayfin-core@1.20.0`'s shipped `assets/docs`
- **AND** the newer decorator SHALL NOT appear as an available feature in the installed docs corpus

#### Scenario: Project-local package resolution
- **GIVEN** a machine has multiple Rayfin projects or global/npx Rayfin tooling installs
- **WHEN** CLI or MCP creates `DocsService` with `discover.from` set to the user's project directory
- **THEN** package resolution SHALL use that project's local Node resolution chain
- **AND** SHALL NOT use Rayfin packages installed for another project or for the global/npx tool itself

#### Scenario: Live session package changes
- **GIVEN** an MCP server is already running for a project
- **WHEN** the project installs or updates a Rayfin package that ships `rayfinDocs`
- **THEN** the next docs tool request SHALL validate the installed-package fingerprint before answering
- **AND** SHALL rebuild or reload the index if the fingerprint changed

#### Scenario: New functionality requires a package update
- **GIVEN** an agent searches installed docs for a feature and finds no matching result
- **WHEN** `discover_packages` or `rayfin docs discover` returns a catalog package related to that feature
- **THEN** the response SHALL include both an install command for missing packages and an update command for
  already-installed packages
- **AND** the response SHALL explain that package docs are version-locked to the installed package version

### Requirement: Multi-source Search Index

The library's `SearchIndex` SHALL merge content from multiple discovered packages into a single searchable index
and serve queries that span any subset of those sources.

#### Scenario: Cross-package search
- **GIVEN** the discovered set includes `@microsoft/rayfin-core@1.30.0` and `@microsoft/rayfin-data@1.30.0`
- **WHEN** an agent queries `search_docs(query: "entity")`
- **THEN** results from both packages SHALL appear in the merged result list
- **AND** each result SHALL carry a `package` field identifying its source

#### Scenario: Globally-unique doc IDs
- **GIVEN** two packages each contain a doc named `index.md`
- **WHEN** the search index is built
- **THEN** each doc SHALL have a globally-unique ID prefixed by the package's `module` value (e.g.
  `rayfin-core::decorators/index.md`)

### Requirement: Index Caching

The library SHALL cache the merged search index on disk to avoid rebuilding from scratch on every cold start.

#### Scenario: Cache hit
- **WHEN** the cache key, computed from schema version, search-index config, requested modules, and each selected
  package's name, version, manifest module, and manifest kind, matches an existing cached index file
- **THEN** the library SHALL load the cached index from disk
- **AND** SHALL NOT re-parse markdown docs or rebuild the MiniSearch index

#### Scenario: Cache miss / invalidation
- **WHEN** any cache-key input differs from the cached fingerprint
- **THEN** the library SHALL rebuild the index from scratch
- **AND** SHALL persist the new index keyed by the new fingerprint
- **AND** SHALL remove older discovered-index cache files from the same project-scoped cache directory

#### Scenario: Cache bypass for debugging
- **WHEN** consumers pass a `--no-cache` flag (or equivalent option)
- **THEN** the library SHALL skip the cache read and always rebuild
- **AND** SHALL still update the cache after rebuilding (so subsequent runs benefit)

### Requirement: Docusaurus Package Docs Rendering

The Docusaurus site SHALL render docs from the same package-owned `assets/docs` trees that MCP and CLI serve
through `@microsoft/rayfin-docs`.

#### Scenario: Site uses package-owned docs
- **WHEN** `docs-site` builds
- **THEN** its Docusaurus docs plugin instances SHALL be generated from `@microsoft/rayfin-docs` discovery results
- **AND** each plugin instance SHALL point at a package's declared `rayfinDocs.dir`
- **AND** the site SHALL NOT copy docs from `packages/docgen/dist` into `docs/site/docs` before building

### Requirement: Cross-package Symbol Resolution

The library's `SymbolResolver` SHALL resolve cross-package symbol references at search/get time across all
discovered packages.

#### Scenario: Cross-reference traversal
- **GIVEN** `@microsoft/rayfin-client::RayfinClientConfig` extends
  `@microsoft/rayfin-lib::ApiClientConfig`
- **WHEN** the agent retrieves the `RayfinClientConfig` doc
- **THEN** the doc body SHALL link to the `ApiClientConfig` doc using the globally-qualified ID
- **AND** the agent SHALL be able to follow the reference via a subsequent `get_doc` call

### Requirement: Catalog Resolution

The library SHALL include a `CatalogResolver` that surfaces packages from the curated catalog bundled in
`@microsoft/rayfin-docs` when the user's installed packages don't satisfy a query.

#### Scenario: Discover not-yet-installed package
- **GIVEN** the user has `@microsoft/rayfin-core` installed but not `@microsoft/rayfin-storage`
- **WHEN** the agent calls `discover_packages(query: "blob upload")`
- **THEN** `CatalogResolver` SHALL return `@microsoft/rayfin-storage` with its summary, topics, and
  install command
- **AND** the result SHALL be framed as an install recommendation when no installed docs matched the query

#### Scenario: Discover newer package functionality
- **GIVEN** the user has an older Rayfin package installed
- **AND** the installed package's `rayfinDocs` content does not mention a feature the agent is searching for
- **WHEN** the agent calls `discover_packages` with that feature query
- **THEN** `CatalogResolver` SHALL return relevant Rayfin packages from the bundled catalog
- **AND** each result SHALL include an update command such as `npm install <package>@latest`
- **AND** the result SHALL instruct the agent that upgrading the package is how newer functionality and its
  matching docs become discoverable

#### Scenario: Bundled catalog versioning
- **WHEN** a `@microsoft/rayfin-docs` release updates the bundled catalog
- **THEN** consumers SHALL use the catalog shipped with the installed package version
- **AND** offline-only consumers SHALL continue to work from that bundled snapshot
