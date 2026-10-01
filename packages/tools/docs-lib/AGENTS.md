# Rayfin docs library agent notes

`@microsoft/rayfin-docs` is the shared docs engine for `rayfin docs` and `@microsoft/rayfin-mcp`.
It discovers package-owned docs through each installed package's `rayfinDocs` package.json field and loads markdown from that package's `assets/docs` directory by default.

## Discovery model

- Discovery is scoped to trusted Rayfin packages only.
- Use `discover: { from: process.cwd() }` for CLI and MCP callers so docs are version-locked to the user's project dependencies.
- Support local and global tool installs by walking `node_modules` from the caller's current working directory and parent directories.
- Treat omitted `rayfinDocs.dir` as `assets/docs`, but reject empty, absolute, or traversal paths.
- Keep realpath guards for package roots, docs roots, and individual files so symlinks cannot escape the installed package.
- Do not fall back to the old `@microsoft/rayfin-mcp/assets/docs` bundled corpus.

## API behavior

- Prefer IDs for exact lookup because relative paths like `index.md` can exist in multiple packages.
- `getDocByPath()` must return a result only when the path is unambiguous.
- Use `getDocsByPath()` when callers need to surface ambiguity and list candidate IDs.
- Apply module filters before loading/indexing discovered docs, including cache-backed paths.
- Use catalog discovery for missing-package or too-old-package guidance instead of returning newer docs from a package the project did not install.

## Validation

Run focused docs-lib tests with `rushx test -- src/__tests__/discovery.test.ts src/__tests__/docs.test.ts` from `packages/tools/docs-lib`.
For cross-package changes, also run the relevant CLI or MCP tests from their package directories.
