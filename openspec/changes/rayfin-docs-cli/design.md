## Context

Rayfin's docs corpus is a versioned set of markdown files (`docs/site/docs/{guide,host,ts-sdk}/`) compiled into a `minisearch` index by `DocsService` (`packages/tools/mcp/src/docs/`).
The MCP server (`@microsoft/rayfin-mcp`, FastMCP + stdio JSON-RPC) exposes that index as three tools (`list_docs`, `get_doc`, `search_docs`).
The corpus is bundled into the npm tarball as `assets/docs/` so that consumers do not need a network call or a docs build to query it.

This change layers a CLI transport over the same `DocsService` instance, so two transports back the same content with the same search ranking.
The CLI version-locks against the docs corpus by depending on `@microsoft/rayfin-mcp` as a workspace runtime dependency: when a user installs `@microsoft/rayfin-cli`, npm pulls the corresponding `@microsoft/rayfin-mcp` tarball (with its bundled assets) and the CLI reads `node_modules/@microsoft/rayfin-mcp/assets/` via the same `import.meta.url`-resolved path the MCP server uses.

## Goals / Non-Goals

**Goals:**

- Provide a docs lookup surface for agents that cannot or do not load third-party MCP servers.
- Keep the docs content **byte-for-byte identical** between transports for a given CLI version.
- Reuse the existing `DocsService` rather than maintain a parallel docs loader/index.
- Use the same `--json` envelope shape (`status`, `schemaVersion`) as `rayfin init ai-files status --json` so JSON consumers see one shape across the CLI.
- Provide a reproducible eval harness so future contributors can confirm the two transports stay in sync on content and characterize the latency difference.

**Non-Goals:**

- Replacing the MCP server. The MCP remains the primary surface; SKILL/AGENTS guidance is not rewritten to point at the CLI.
- Per-package scoping inside the `ts-sdk` module (e.g. `package: '@microsoft/rayfin-data'`). Tracked under Tier 1 Task B in the agent-friendliness plan.
- Search ranking improvements (boost tuning, labeled query set). Same Tier 1 Task B work.
- Auto-generated CLI quick-reference inside `SKILL.md`. Tier 0 Task A, separate worktree.
- Trimming the CLI's transitive footprint. The CLI now pulls in `fastmcp`, `zod`, and `tsx` via the `@microsoft/rayfin-mcp` dep even though `rayfin docs` does not use them. See the Follow-ups section below.

## Decisions

### 1. Re-use `@microsoft/rayfin-mcp` rather than carve out a new package

**Rationale:** The lighter-touch path. `DocsService`'s asset locator (`import.meta.url`-based) keeps working because the `mcp` package ships its assets in its own tarball; consumers reach them via `node_modules/@microsoft/rayfin-mcp/assets/` regardless of which workspace package imports the class. Carving the docs code into a separate package is a larger refactor and is tracked as a follow-up below.

**Alternatives considered:** Promote `DocsService` + assets into a new leaf package (e.g. `@microsoft/rayfin-docs`) and depend on it from both `rayfin-cli` and `rayfin-mcp`. Rejected for this PR because it expands scope; deferred to the follow-up.

### 2. Factory + const dual-export per subcommand

**Rationale:** Tests drive Commander instances repeatedly with different argv; module-scoped Commander state retains options across runs, leaking values between describe blocks. Factories (`createListCommand`, etc.) produce a clean instance per call. The runtime registration path uses the const default to keep the registration shape unchanged.

### 3. JSON envelope mirrors `ai-files status --json`

**Rationale:** Same `status` + `schemaVersion: 1` preamble. JSON consumers of `rayfin --json` outputs see a uniform shape across commands. Bumping `schemaVersion` is reserved for breaking shape changes.

### 4. CLI is an explicit fallback, not a competitor to MCP

**Rationale:** The command's `description`, the human-mode "Next:" hints, and the PR/spec text all frame MCP as primary. We do not want this to dilute the agent guidance baseline that PR #1126 establishes. The eval harness is the objective check on whether the CLI is keeping up content-wise.

### 5. Eval harness lives under `packages/tools/cli/eval/`

**Rationale:** The harness is dev-only — it builds against the workspace's own dist outputs, runs locally, and writes a snapshot to `RESULTS.md`. The path is excluded from the published tarball by the existing `files` array. Co-locating with the CLI keeps the harness next to the surface it measures.

### 6. Builder default = `guide` + `ts-sdk`; host loaded only on opt-in

**Rationale:** Empirical search-relevance check on the PR (`"sign in"` → 0/10 host hits, `"magic link"` → 3/10 host hits, no guide-to-host cross-links) showed host docs are .NET reference noise for typical builder queries while consuming ~70% of corpus weight (429 of 682 files, ~1.1 MB of ~1.6 MB). The default loaded module set is therefore `['guide', 'ts-sdk']` for both transports. Host stays bundled in `assets/` and is reachable via opt-in — `rayfin docs --module host ...` (CLI constructs a host-only `DocsService` for that one invocation) or `raymcp start --host-docs` (MCP server flavour with host-only index).

The earlier "load all 3 by default" alignment (an interim Decision in this PR's history) is reverted in favour of this builder-focused default. Parity (`RAYFIN-DOCS-CLI-003`) holds against the chosen default for both transports; the eval harness's two-suite shape (default + host) verifies parity for the opt-in path too.

**Alternatives considered:** Continue loading all 3 by default. Rejected because `host` adds search noise on builder queries, bloats the steady-state index (slowing both cold start and warm queries), and increases agent token cost without proportional benefit for the typical user.

### 7. Pre-built minisearch index serialized at build time

**Rationale:** The largest cold-start cost in the CLI was `DocsService` construction (walking 252 default-set markdown files, parsing front matter, splitting sections, building the minisearch index from scratch — ~1.5–2 s). The mcp `prebuild` step now emits `assets/docs.search.json` covering the builder-default module set, and `DocsService` rehydrates from JSON via `MiniSearch.loadJSON` when the prebuilt's `schemaVersion`, config fingerprint, and module set all match. Otherwise it falls back to source-building (host opt-in path, test setups with custom asset roots).

A single `DOCS_SEARCH_OPTIONS` constant in `search.ts` is the source of truth for both build-time index construction and runtime rehydration; its `JSON.stringify` is the config fingerprint stored in the envelope. Schema version bumps invalidate stale prebuilts. The serialized envelope is ~1.5 MiB on top of the ~500 KiB markdown source — a real cost paid once at install for a measured ~12-15× cold-start speedup on default queries.

### 8. Lazy-load CLI heavy deps for the `docs` path

**Rationale:** `packages/tools/cli/scripts/main` is restructured so that the docs-only invocation path skips the eager top-level imports of `dist/index.js` (which transitively pulls in MSAL, OpenTelemetry, dotenv, inquirer, ora, figlet, archiver, the init/dev/up command tree, etc.) and `dist/telemetry/index.js`. A small argv-walk detects unambiguous `docs` invocations (skipping help, version, and unknown options to stay conservative) and routes them through a minimal Commander tree containing only the docs command group plus `errors.js` for consistent `CliHandledError` mapping.

All other CLI invocations keep the eager-load path verbatim. Help, version, and the full command tree's behavior are unchanged.

### 9. Skip telemetry init for the read-only `docs` path

**Rationale:** `rayfin docs` is read-only and stateless. There is no telemetry signal worth ~50–100 ms of Azure Monitor SDK initialization on every invocation. The lazy `docs` branch in `scripts/main` simply does not call `initTelemetry()` / `shutdownTelemetry()`. Stacks with Decision 8.

## Risks / Trade-offs

- **Distribution size.** `@microsoft/rayfin-cli` now indirectly redistributes the bundled docs corpus, the prebuilt search index, and the MCP server's transitive deps. Measured on PR #1143: ~1.6 MB markdown corpus + ~1.5 MB prebuilt index + ~5.9 MB of unused transitive deps (`fastmcp`, `zod`, `tsx`) for a total of ~9.9 MB on disk after `npm install`. Follow-up F1 targets the transitive-dep tax (~5.9 MB of the total).
- **Drift risk between transports.** Two surfaces over the same service should always agree, but a regression in either thin layer (the CLI command or the MCP tool) could silently diverge. The eval harness's result-set equivalence check is the canonical guard.
- **Prebuilt-index staleness.** A contributor who edits markdown without rerunning the `mcp` prebuild would ship a stale search index. The `DOCS_SEARCH_CONFIG_FINGERPRINT` and `DOCS_INDEX_SCHEMA_VERSION` invariants catch *config* drift but not *content* drift. The `prebuild` script is wired to run on every `rush build` of `@microsoft/rayfin-mcp`, so the only path to staleness is editing markdown without rebuilding mcp - same risk profile as any generated asset in the repo.
- **Module-aware service caching.** The CLI's `getDocsService(moduleFilter)` keys the cache by module set so default queries and `--module host` queries don't share an instance. A test that mocks `DocsService` via `setDocsServiceForTesting` only mocks the default cache slot; tests for the host opt-in path must construct or mock the host slot explicitly.

## Follow-ups

These are the follow-up items deliberately scoped out of this PR. They live here (in design.md) rather than as issues per the project's "no follow-up issues" practice.

### F1. Carve `DocsService` into a leaf package (size optimization)

**What:** Extract `DocsService`, the docs loader, the search index, and the `assets/docs/` corpus into a new leaf package — working name `@microsoft/rayfin-docs` — that depends only on `minisearch`. Both `@microsoft/rayfin-mcp` (server) and `@microsoft/rayfin-cli` (CLI command group) consume it.

**Why:** Today the CLI inherits ~5.9 MB of transitive deps (`fastmcp`, `zod`, `tsx`) from `@microsoft/rayfin-mcp` that the `rayfin docs` command never imports. The split removes those deps from the CLI's install graph without giving up any functionality. Measured impact: ~5.9 MB / ~70% reduction of the transitive-dep footprint added by this PR.

**Constraint - version-lock the corpus to the CLI:** The bundled markdown corpus must continue to ship in lockstep with `@microsoft/rayfin-cli`. Two acceptable shapes:

1. New leaf package owns the corpus and lockstep-versions with the CLI (Rush version policy entry, same major/minor as the typescript-sdk lockstep). The CLI depends on a pinned exact version, not a range, so a `npm install @microsoft/rayfin-cli@x.y.z` always pulls the exact corpus that shipped with that CLI.
2. Or: leaf package owns only `DocsService` + index code; the corpus stays in `@microsoft/rayfin-cli`'s own assets and is passed to `DocsService` via its `assetsRoot` constructor option. The MCP server keeps its own copy. This trades a slight duplication of the markdown for stronger version coupling between CLI and corpus.

The version-lock requirement comes from the user contract: `rayfin docs` results must reflect the docs that shipped with the installed CLI version. A floating range that lets the docs version drift away from the CLI version would silently break that contract.

**Out of scope until then:** Avoid further work that hardens the current CLI -> mcp dep direction (e.g., do not promote shared utilities into `@microsoft/rayfin-mcp` for the CLI to consume, since that direction reverses on the split).

### F2. Per-package scoping in the `ts-sdk` module

**What:** Allow `--module ts-sdk --package @microsoft/rayfin-data` to filter to a single SDK package's docs.
**Why:** Tier 1 Task B in the agent-friendliness plan. Returns smaller, more relevant result sets for agents working on a specific SDK package.

### F3. Search ranking improvements

**What:** Tune minisearch boost weights against a labeled query set. Promote symbol exact matches over full-text body hits when the query string equals a known symbol.
**Why:** Tier 1 Task B. Improves agent landing page on the right doc on first hit.

### F4. CLI quick-reference auto-generated into `SKILL.md`

**What:** Generate the `rayfin docs` (and other CLI command) usage table from the Commander tree at build time.
**Why:** Tier 0 Task A. Avoids drift between the SKILL and the actual command surface.

### F5. Drop the MCP tool description's misleading default-scope claim

**What:** The `search_docs` MCP tool description says default `all`, but the implementation passes through to `DocsService` whose default is `docs`. Pick one and align.
**Why:** Surfaced by the eval-harness rubber-duck pass on this PR. Cosmetic but it confuses agents reading the tool description.

<!-- F6, F7, F8, F9 were applied in this PR. See Decisions 6-9 above for the as-shipped behavior. -->
