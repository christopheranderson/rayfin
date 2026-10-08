# Rayfin host docs agent notes

`@microsoft/rayfin-host-docs` ships host reference markdown for version-locked docs lookup.
Agents access this package through `@microsoft/rayfin-docs`, `rayfin docs` subcommands with `--module host` (for example, `rayfin docs search <query> --module host`), and the Rayfin MCP server when it is started with host docs enabled.

## Docs convention

- Keep docs under `assets/docs`.
- Keep `package.json` `rayfinDocs.module` aligned with the IDs exposed by the docs service.
- Host docs are .NET reference content and are not loaded by the MCP default Builder module set.
- Use `--module host` in CLI examples and `--host-docs` for MCP host-reference workflows.
- `--host-docs` is host-only mode for MCP: it loads only the host module and replaces the default guide plus TypeScript SDK set.
- Do not describe host APIs from a newer package version unless that package's docs have been updated in the same change.

## Validation

Run `rush docs:lint` from the repo root after editing markdown.
