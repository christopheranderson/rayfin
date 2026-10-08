# Rayfin guide docs agent notes

`@microsoft/rayfin-guide` ships Builder guide markdown for version-locked docs lookup.
Agents access this package through `@microsoft/rayfin-docs`, `rayfin docs`, and the Rayfin MCP server.

## Docs convention

- Keep docs under `assets/docs`.
- Keep `package.json` `rayfinDocs.module` aligned with the IDs exposed by the docs service.
- Use Builder-facing language and commands.
- Prefer `npm` or `npx` commands in Builder docs, not Rush contributor commands.
- Do not describe APIs from a newer package version unless that package's docs have been updated in the same change.

## Validation

Run `rush docs:lint` from the repo root after editing markdown.
