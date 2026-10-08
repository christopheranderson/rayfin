## 1. Library exports from `@microsoft/rayfin-mcp`

- [x] 1.1 Re-export `DocsService` from `packages/tools/mcp/src/index.ts`.
- [x] 1.2 Re-export public types: `DocEntry`, `DocListItem`, `DocModule`, `DocSearchResult`, `DocSearchScope`, `DocSection`, `DocSectionRef`.
- [x] 1.3 Confirm `mcp` tests still pass with no behavior change to the server execution path.

## 2. CLI `docs` command group

- [x] 2.1 Add `packages/tools/cli/src/commands/docs/docs.ts` with a `Commander` group + factory.
- [x] 2.2 Add `list.ts`, `search.ts`, `get.ts` subcommands, each exporting a factory and a const instance.
- [x] 2.3 Add `helpers.ts` with shared flag parsers (`parseModuleFlag`, `parseScopeFlag`, `parseLimitFlag`), a memoized `DocsService` accessor, the `jsonOk` envelope helper, and a CLI-handled-error normaliser.
- [x] 2.4 Wire the `docs` group into `packages/tools/cli/src/index.ts`.
- [x] 2.5 Add `@microsoft/rayfin-mcp: workspace:*` to `packages/tools/cli/package.json` `dependencies`.

## 3. `--json` envelope shape

- [x] 3.1 Use `{ status: 'ok' | 'error', schemaVersion: 1, ... }` preamble for every JSON path.
- [x] 3.2 `list --json`: include `module`, `count`, `items`.
- [x] 3.3 `search --json`: include `query`, `module`, `scope`, `limit`, `count`, `results`.
- [x] 3.4 `get --json` (id/path): include `entry`.
- [x] 3.5 `get --json` (symbol): include `symbol`, `module`, `count`, `sections`.
- [x] 3.6 Error path: `{ status: 'error', schemaVersion: 1, error: '...' }` with non-zero exit.

## 4. Tests

- [x] 4.1 23 unit tests in `helpers.test.ts` covering flag parsing + envelope shape.
- [x] 4.2 13 end-to-end tests in `commands.test.ts` against a stubbed `DocsService` (mirrors the up-status `emitJson` mocking pattern).
- [x] 4.3 Confirm full CLI test suite passes with no regressions.

## 5. Eval harness

- [x] 5.1 Add `packages/tools/cli/eval/docs-transports/` directory.
- [x] 5.2 `eval.ts` orchestrator running representative queries against both transports.
- [x] 5.3 `mcp-client.ts` minimal stdio JSON-RPC client (initialize, notifications/initialized, tools/call).
- [x] 5.4 `queries.ts` covering `list`, `get` (id/symbol), `search` (with/without module, with/without scope), and a small "error behavior" set.
- [x] 5.5 Per-operation extractors that strip envelope only and deep-equal the inner content.
- [x] 5.6 `RESULTS.md` header captures git SHA, Node version, OS, package versions, corpus byte/file counts, run params (`RUNS_PER_QUERY`, `WARMUP_RUNS`).
- [x] 5.7 Spawn env sets `RAYFIN_TELEMETRY_OPTOUT=1` for both transports.
- [x] 5.8 `README.md` documents how to reproduce and explicitly states the harness is manual / not run in CI.
- [x] 5.9 `eval:docs-transports` script in `packages/tools/cli/package.json`.
- [x] 5.10 Run the harness; commit `RESULTS.md` (10/10 equivalence after the MCP default fix).
- [x] 5.11 First-run finding: MCP and CLI defaults were aligned on `['guide', 'ts-sdk']`; `--host-docs` remains an opt-in host-only mode.

## 6. Documentation

- [x] 6.1 Update PR #1143 description with the new title, the openspec change reference, and a link to the eval results.
- [ ] 6.2 (Deferred) Update `docs/site/docs/guide/cli/index.md` to reference the `docs` command group. Tracked under Tier 0 Task A (auto-generated quick-reference).
