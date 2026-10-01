## Phase 1 — Extract `rayfin-docs` library

Pure code refactor. Surfaces switch their imports and stop treating MCP as the docs-corpus owner.

### 1.1 Scaffold the new package

- [ ] Create `packages/tools/docs-lib/` with `package.json` (name `@microsoft/rayfin-docs`, on the
      `typescript-sdk` lockstep policy initially).
- [ ] Add to `rush.json`'s `projects` array. Subspace: `default` (lib package, not CLI).
- [ ] `tsconfig.json`, `vitest.config.ts`, `rush-project.json` matching peer SDK packages.
- [ ] Empty `src/index.ts`, `src/__tests__/`.

### 1.2 Lift the docs library code

- [ ] Move `packages/tools/mcp/src/docs/` → `packages/tools/docs-lib/src/`. Files: `index.ts`, `loader.ts`,
      `search.ts`, `resolver.ts` (and any helper modules).
- [ ] Update import paths inside the moved files.
- [ ] Re-export public API from `packages/tools/docs-lib/src/index.ts`: `DocsService`, `DocEntry`,
      `DocListItem`, `DocModule`, `DocSearchResult`, `DocSearchScope`, `DocSection`, `DocSectionRef`,
      `DOCS_DEFAULT_MODULES`.

### 1.3 Re-wire MCP and CLI to import from `rayfin-docs`

- [ ] `packages/tools/mcp/`: replace `import { DocsService } from "./docs/..."` with
      `import { DocsService } from "@microsoft/rayfin-docs"`. Add `@microsoft/rayfin-docs: workspace:*` to deps.
- [ ] `packages/tools/cli/src/commands/docs/`: replace `import { DocsService } from "@microsoft/rayfin-mcp"`
      with `import { DocsService } from "@microsoft/rayfin-docs"`. Add `@microsoft/rayfin-docs: workspace:*`
      to deps.
- [ ] Drop `@microsoft/rayfin-mcp: workspace:*` from `packages/tools/cli/package.json` if the CLI no longer
      uses the MCP server directly. Verify by grepping for any other import paths.

### 1.4 MCP and CLI use package discovery, not MCP assets

- [x] MCP constructs `DocsService` with `discover: { from: process.cwd(), candidates }` and no `assetsRoot`.
- [x] CLI constructs `DocsService` with `discover: { from: process.cwd(), candidates }` and no `assetsRoot`.
- [x] CLI drops its runtime dependency on `@microsoft/rayfin-mcp` for docs serving.
- [x] Tests assert the MCP server passes discover-only options into `DocsService`.

### 1.5 Test migration

- [ ] All `mcp` package tests pass with the new import paths.
- [ ] All `cli/src/commands/docs/__tests__/` tests pass with the new import paths.
- [ ] New tests in `docs-lib/src/__tests__/` covering `DocsService` directly (lifted from the existing
      mcp tests; mcp package now only tests its MCP-tool surface).

### 1.6 Phase 1 eval gate

- [ ] Re-run `eval/llm-agent-comparison/eval.ts` at N=5 and compare aggregates against the prior
      `RESULTS.md` baseline (commit d099356c). Acceptance: wall-time within 10%, correctness unchanged.
- [ ] Document the comparison in `RESULTS.md` (new "Phase 1 vs baseline" section).

## Phase 2 — `rayfinDocs` convention + multi-source discovery

Convention defined; pilot one SDK package; indexer learns to merge package-owned docs.

### 2.1 Define the `rayfinDocs` field

- [ ] Document the field in `packages/tools/docs-lib/README.md` (schema, examples, kind values).
- [ ] Add a JSON Schema for the field at `packages/tools/docs-lib/schemas/rayfin-docs-field.schema.json`.
- [ ] Add a runtime validator (`validateRayfinDocsField`) that returns structured errors for malformed
      declarations (used by `PackageDiscovery`).

### 2.2 Implement `PackageDiscovery`

- [ ] New module `packages/tools/docs-lib/src/discovery.ts` exporting `PackageDiscovery`.
- [ ] Walk strategy: starting from `process.cwd()` (or an injected root), find the nearest
      `node_modules/`, then iterate every package directory looking for `package.json` with a `rayfinDocs`
      field. Validate each.
- [x] Return shape includes package name, package version, package root, manifest module, and kind.
- [x] `DocsService` defaults to the catalog-derived known Rayfin package candidate list so docs validation does not
      walk every unrelated `node_modules` package.
- [x] Superseded by content-addressed disk index caching plus per-request package fingerprint validation; no separate process-only mtime cache is used.

### 2.3 Multi-source indexing

- [ ] Modify `DocsService` to accept `sources: PackageDocsSource[]` instead of a single `assetRoot`.
- [ ] `loadDocs` walks all sources and merges. Doc IDs become globally-unique by prefixing with the
      package's `module` field (e.g. `rayfin-core:decorators/blob.md` instead of just
      `ts-sdk:.../blob.md`).
- [ ] Search index merges across sources. Search results carry a `package` field so callers can show
      provenance.
- [ ] Remove MCP/CLI use of the old single-`assetsRoot` constructor. Any remaining `assetsRoot` support is
      test-only or migration-only and must not be used by agent-facing surfaces.

### 2.4 Disk cache for the merged index

- [x] Cache key includes schema version, search-index config, requested modules, and each selected package's name,
      version, manifest module, and manifest kind (Decision 7).
- [x] Cache location: `~/.rayfin/cache/docs-index-<hash>.json` with equivalent temp-dir fallback when the default
      cache path is unwritable.
- [x] Cache invalidation: any cache-key input mismatch → rebuild.
- [x] Cache cleanup: after writing the current discovered-index cache, prune stale `docs-index-*.json` files from
      the same project-scoped cache directory.
- [x] MCP validates the installed-package fingerprint on each docs request so long-running sessions notice package
      installs or updates.
- [x] CLI/MCP flag `--no-cache` to bypass for debugging.
- [x] Tests covering cache hit, miss, and invalidation paths.

### 2.5 Pilot one SDK package

- [ ] Pick `@microsoft/rayfin-core` (largest doc surface).
- [ ] Update the docgen pipeline to emit `packages/typescript-sdk/core/assets/docs/` in addition to the
      central `docs/site/docs/ts-sdk/@microsoft/rayfin-core/`. (Both for now; central goes away in Phase 3.)
- [ ] Add `rayfinDocs` field to `packages/typescript-sdk/core/package.json`.
- [ ] Update `package.json` `files` array to include `assets/docs`.
- [ ] Verify that the indexer discovers core's docs from the installed package version.
- [ ] Add an integration test in `docs-lib` that loads a fixture multi-source setup.

### 2.6 Cross-package symbol resolution

- [ ] Update the docgen pipeline to emit globally-qualified IDs in TypeDoc-generated markdown
      (e.g. `@microsoft/rayfin-core::EntityClient` instead of plain `EntityClient`).
- [ ] `SymbolResolver` walks references at search/get time across all discovered packages.
- [ ] Test: a query for a symbol defined in core that's referenced in client returns both packages'
      relevant entries.

### 2.7 Phase 2 eval gate

- [ ] Re-run N=5 eval. Pilot package's docs come from the per-package source; rest from bundled.
- [ ] Acceptance: zero correctness regression; wall-time within 5% of Phase 1 numbers.

## Phase 3 — Migrate all SDK packages

Every lockstep SDK package ships its own docs; bundled corpus drops; rayfin-guide ships;
TypeDoc gap closed.

### 3.1 Generate per-package docs for every typescript-sdk package

For each of: `rayfin-auth`, `rayfin-auth-provider-fabric`, `fabric-embedded-host`, `rayfin-client`,
`rayfin-core`, `rayfin-data`, `rayfin-functions`, `rayfin-lib`, `rayfin-react`, `rayfin-storage`:

- [ ] Add a TypeDoc emit target in the central docgen config.
- [ ] Add `assets/docs/` and `rayfinDocs` declaration to each package's `package.json`.
- [ ] Update each package's `files` array to include `assets/docs`.
- [ ] Run docgen + verify each package builds with its own docs.

This closes the TypeDoc coverage gap (`rayfin-storage`, `rayfin-functions`, `rayfin-react`,
`rayfin-auth-provider-fabric`, `fabric-embedded-host` previously had no reference docs).

### 3.2 Create `@microsoft/rayfin-guide`

- [ ] Scaffold `packages/guide/` with `package.json` (name `@microsoft/rayfin-guide`, on the lockstep
      policy initially per Q1 in design.md).
- [ ] Move `docs/site/docs/guide/` content into `packages/guide/assets/docs/`.
- [ ] Update Docusaurus config (`docs/site/docusaurus.config.ts`) to source guide content from the new
      location during site builds.
- [ ] Add `rayfinDocs` field to `packages/guide/package.json` with `kind: "guide"`.

### 3.3 Drop the bundled corpus from `rayfin-mcp`

- [x] Remove `packages/tools/mcp/build-scripts/build-search-index.ts` and the `prebuild` script.
- [x] Remove generated `packages/tools/mcp/assets/docs/` and `assets/docs.search.json` from the build contract.
- [x] Update `packages/tools/mcp/package.json` `files` array — drop `assets`.
- [x] Update `rush-project.json` `outputFolderNames` accordingly.
- [x] Keep `@microsoft/rayfin-mcp` on the existing major and record the behavior change as a minor update; the removed asset path was internal and the MCP tool surface is preserved (Decision 9).

### 3.4 Migrate the eval's `raw-docs` transport

- [ ] Update `eval/llm-agent-comparison/copilot-agent.ts` `RAW_DOCS_DIR` to walk all installed
      `rayfinDocs`-declaring packages instead of pointing at the (now-gone) `mcp/assets/docs/`.
- [ ] Update the prompt to describe per-package docs structure.
- [ ] Re-run smoke test on a fresh node_modules to confirm the agent finds docs via the new path.

### 3.5 Migration documentation

- [ ] Add `MIGRATING.md` in `packages/tools/mcp/` documenting the 1.x → 2.x changes.
- [ ] Add a CHANGELOG entry for `rayfin-mcp`, `rayfin-docs`, and each migrated SDK package.
- [ ] Search the repo for any other consumer reaching into `node_modules/@microsoft/rayfin-mcp/assets/docs/`
      and migrate.

### 3.6 Phase 3 eval gate

- [ ] Re-run N=5 eval. All transports working; bundled corpus is gone.
- [ ] Acceptance: zero correctness regression; wall-time within 5% of Phase 2 numbers.

## Phase 3b — Docusaurus site reads from per-package `assets/docs/` (Option A)

Closes the "two physical copies of the same content" gap. The per-package `assets/docs/` becomes the single
source of truth — the Docusaurus site stops authoring under `docs/site/docs/` and instead renders directly
from per-package paths via `@docusaurus/plugin-content-docs` multi-instance. See design.md Decision 10.

This phase is part of the current PR scope so the website, CLI, and MCP all read the same package-owned docs.

### 3b.1 Per-package TypeDoc emit

- [ ] Update `packages/docgen/` to iterate `@microsoft/rayfin-*` SDK packages and emit each package's TypeDoc
      output to `packages/typescript-sdk/<pkg>/assets/docs/reference/` (in addition to or instead of the
      current single emit target).
- [ ] Each per-package emit honours the same docgen options the central config uses today (entry points,
      excludes, plugin set).
- [ ] Validate by running `rush docs:typedoc` and confirming each SDK package now contains a populated
      `assets/docs/reference/` tree.

### 3b.2 Per-package DocFX emit (host)

- [ ] Configure DocFX in the .NET host repo to emit reference markdown into
      `packages/host-docs/assets/docs/reference/` (the package introduced in Phase 5).
- [ ] CI step that publishes the host-docs package on each host release picks up the per-package output.
- [ ] Validate by building host-docs and confirming the `reference/` tree matches what the existing site
      ships today.

### 3b.3 Migrate the Builder guide content into `@microsoft/rayfin-guide`

- [ ] `git mv docs/site/docs/guide/* packages/guide/assets/docs/`.
- [ ] Update internal links across the migrated content to use the new route base (`/guide/...`).
- [ ] Confirm no other consumer is reaching into `docs/site/docs/guide/` directly (search the repo).

### 3b.4 Configure `@docusaurus/plugin-content-docs` multi-instance

- [x] Update `docs/site/docusaurus.config.js` to register multiple `content-docs` plugin instances:
  - `guide` instance → `path: '../../packages/guide/assets/docs'`, `routeBasePath: '/docs/guide'`
  - per-SDK-package instances → `path: '../../packages/typescript-sdk/<pkg>/assets/docs'`,
    `routeBasePath: '/docs/ts-sdk/<rayfin-module>'` (one per package)
  - `host` instance → `path: '../../packages/host-docs/assets/docs'`, `routeBasePath: '/docs/host'`
- [x] Ensure each instance has a unique `id` and its own sidebar config.
- [ ] Validate by running `rushx start` from `docs/site` and visually confirming every doc area renders
      under its expected route, with cross-links resolving.

### 3b.5 Gitignore the legacy site-doc tree

- [ ] Add `docs/site/docs/{guide,host,ts-sdk}/` to `docs/site/.gitignore`.
- [ ] Remove the now-orphaned tracked content under those paths in the same commit as the gitignore add.
- [ ] Confirm `rush docs:lint` still passes (markdownlint runs on the per-package author locations now).

### 3b.6 Regression validation

- [ ] Run N=1 regression eval after the migration to confirm no correctness regression vs the Phase 5
      baseline. Larger N=5 reserved for if the regression-pass surfaces signal that warrants it.
- [x] Build the docs site in production mode (`rushx build` from `docs/site`) and spot-check the rendered
       output against the pre-migration site for layout / link parity.

### 3b.7 Once Phase 3b is in: drop the bundled corpus from `rayfin-mcp`

- [x] The bundled corpus in `rayfin-mcp` is redundant after the migration; per-package docs are the canonical
      source for both website and agent, and the MCP package records the change without a major bump (Decision 9).

## Phase 4 — bundled catalog + `discover_packages`

Catalog manifest, MCP/CLI discovery surfaces, eval gains discovery-task assertions.

### 4.1 Create the bundled catalog snapshot

- [ ] Add `packages/tools/docs-lib/assets/catalog.json` with the schema from design.md Decision 4.
- [ ] Keep the catalog snapshot inside `@microsoft/rayfin-docs` so catalog and resolver updates ship together.

### 4.2 `CatalogResolver`

- [ ] New module `packages/tools/docs-lib/src/catalog.ts` exporting `CatalogResolver`.
- [ ] API: `CatalogResolver.discover(query: string): { name, summary, topics, installCommand,
      homepageUrl }[]` — searches the bundled catalog for packages matching name/summary/topics.
- [ ] Tests covering exact match, topic match, fuzzy match, miss-with-suggestions.

### 4.3 `discover_packages` MCP tool

- [ ] Add the tool to `packages/tools/mcp/src/mcp.ts`. Description tuned for agent legibility.
- [ ] Wire to `CatalogResolver.discover`.
- [ ] Tests in mcp's tool-surface suite.

### 4.3a Version-lock guidance in discovery results

- [x] `discover_packages` and `rayfin docs discover` responses include an install command for packages that are
      not installed.
- [x] Responses include an update command for packages that are installed but may be too old to contain the
      requested feature.
- [x] Responses explain that docs are served from the package version installed in the current project.

### 4.4 `rayfin docs discover` CLI subcommand

- [ ] Add `packages/tools/cli/src/commands/docs/discover.ts`.
- [ ] Argv: `rayfin docs discover <query> [--json] [--lean]`.
- [ ] Output: human-readable list of catalog matches with install commands; JSON shape mirrors the
      MCP tool output.
- [ ] Tests.

### 4.5 Eval discovery tasks

- [ ] Update `eval/llm-agent-comparison/tasks.ts`: T3 (stripe) and T7 (realtime) gain a path where the
      agent can score full credit by surfacing a `discover_packages` answer (e.g. "Stripe payments aren't
      in your installed Rayfin packages, but no Rayfin package covers Stripe directly — handle it in your
      app layer").
- [ ] Acceptance: T3 + T7 pass rate goes from current ~3/5 to 5/5 across all three transports.

### 4.6 Phase 4 eval gate

- [ ] Re-run N=5 eval. Discovery tasks scored against the new path.
- [ ] Acceptance: T3 + T7 pass rate ≥ 4/5; aggregate wall-time within 5% of Phase 3.

## Phase 5 — Host-docs decoupling

The remaining drift gap (.NET host) gets attention. Catalog updates remain bundled-only — they ship with
each `@microsoft/rayfin-docs` release. There is no hosted catalog endpoint.

### 5.1 Host docs into `@microsoft/rayfin-host-docs`

- [ ] Create `packages/host-docs/` with `package.json` declaring `rayfinDocs` and `kind: "host"`.
- [ ] The .NET host service repo gets a CI step that publishes `host/` content into this package on each
      host release.
- [ ] Update the indexer to recognise `kind: "host"` packages and merge them into the corpus.

### 5.2 Operational documentation

- [ ] Document the host docs publishing flow (host repo → host-docs package → npm).

## Cross-cutting tasks

- [ ] Eval baseline: archive the current N=5 `RESULTS.md` (commit `d099356c`) as
      `eval/llm-agent-comparison/baselines/n5-pre-architecture.md`. Each phase's eval gate compares
      against the prior phase, with the original baseline preserved as the long-term reference.
- [ ] Update `openspec/specs/builder-documentation/spec.md` to reflect the new content location for
      cross-cutting guides (post-Phase 3).
- [ ] Update `openspec/changes/rayfin-docs-cli/` archive to cross-reference this proposal as the
      F-LEAF-PACKAGE follow-up's evolution (post-archival).
