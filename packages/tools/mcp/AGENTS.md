# Rayfin MCP agent notes

`@microsoft/rayfin-mcp` is the agent-facing MCP server for Rayfin docs.
It should expose docs from the user's installed Rayfin packages, not from a copied docs corpus inside the MCP package.

## Runtime model

- The managed MCP config uses `npx -y @microsoft/rayfin-mcp start`.
- MCP hosts typically launch the server with the user's Rayfin project as `process.cwd()`.
- Build `DocsService` with `discover: { from: process.cwd() }` so local project dependencies win even when the MCP package is installed through `npx`.
- Load Builder guide and TypeScript SDK docs by default.
- Keep `--host-docs` as host-only mode: it loads only the host module and replaces the default guide plus TypeScript SDK set.
- Keep `discover_packages` available when `search_docs` returns no relevant result.

## Tool behavior

- `list_docs`, `search_docs`, and `get_doc` are read-only.
- `get_doc` accepts exactly one of `id`, `path`, or `symbol`.
- When a path maps to multiple package docs, return an ambiguity response with candidate IDs instead of choosing one.
- Keep tool descriptions aligned with the loaded module set so agents know whether host docs are available.

## Validation

Run MCP tests with `rushx test` from `packages/tools/mcp`.
When docs service contracts change, also run focused `@microsoft/rayfin-docs` tests.
