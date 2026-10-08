## Why

Coding agents that ground their answers in Rayfin docs today primarily reach package-owned docs through the `@microsoft/rayfin-mcp` server.
The MCP path works well for agents that load it, but several real populations cannot or do not:

- Agents that have third-party MCP servers disabled by org policy (Caruso flagged this on PR #1126).
- Pipelines, scripts, and humans that want to grep / pipe docs from a shell rather than spin up an MCP client.
- One-shot lookups where the lifecycle of a stdio MCP server (initialize → tools/call → shutdown) is heavier than the actual work.

Both cases need the same content, the same search ranking, and the same version pinning that the MCP server provides — just over a different transport.

## What Changes

- Add a new `rayfin docs` command group with package-scoped subcommands (`list`, `search`, `get`, `discover`, and `catalog show`) that wraps the shared docs package used by the MCP server.
- Extract `DocsService` and its public types into `@microsoft/rayfin-docs` so CLI, MCP, and docs site code consume the same loader without making `@microsoft/rayfin-mcp` the corpus owner.
- The MCP server stays the **primary** docs grounding surface. The CLI is a deliberate **fallback**, not a replacement: command descriptions, `Next:` hints, and SKILL/AGENTS guidance all keep the MCP as the recommended path.
- Add an eval harness under `packages/tools/cli/eval/docs-transports/` that compares CLI vs MCP transports for latency, payload size, and result-set equivalence so future changes to either surface have a reproducible reference point.

## Capabilities

### New Capabilities

- `rayfin-docs-cli`: New CLI command group exposing project-installed Rayfin package docs over a process-per-call transport, with a `--json` envelope shape (`schemaVersion: 1`) compatible with `rayfin init ai-files status --json`.

### Modified Capabilities

- `rayfin-mcp` (informally): the MCP server execution path now reads docs through `@microsoft/rayfin-docs` instead of owning a bundled corpus.

## Impact

- `packages/tools/cli/src/commands/docs/` — new command group source + 36 unit tests.
- `packages/tools/cli/src/index.ts` — register the `docs` command.
- `packages/tools/cli/package.json` — add `@microsoft/rayfin-docs: workspace:*` runtime dep.
- `packages/tools/docs-lib/` — shared `@microsoft/rayfin-docs` package with docs loading, discovery, search, and catalog APIs.
- `packages/tools/cli/eval/docs-transports/` — manual transport eval harness (excluded from the published tarball via the existing `files` array).
- No breaking changes to existing CLI commands or to the MCP tool surface.
