# Docs Site AGENTS

Scope: Docusaurus site under `docs/site` for Contributors.
Use the Rush `docs` subspace.

## Commands

- Install deps: `rush update --subspace docs`
- Dev server: `cd docs/site && rushx start`
- Build: `cd docs/site && rushx build` or `rush build --to docs-site`
- Serve static: `cd docs/site && rushx serve` (pass additional Docusaurus
  flags after `--`)
- Lint markdown: `rush docs:lint`

## Guardrails

- Always run `rushx` commands from `docs/site`.
- If a command fails, capture the full terminal output and confirm `pwd`
  before trying anything else.
- If the recommended command does not work, pause and ask for help rather
  than trying random variants.

## Content Sources

The site renders two distinct kinds of content through a unified SDK
Reference sidebar plus a separate Guide section:

- **Handwritten package docs** (`kind: 'guide'` and `kind: 'reference'` with
  hand-written assets): discovered at config-load time by
  `@microsoft/rayfin-docs` walking the workspace and reading each package's
  `rayfinDocs` manifest. Source of truth lives in each package's
  `assets/docs/` folder.
- **Generated TypeScript SDK API reference**: TypeDoc emits per-module
  trees into `packages/docgen/dist/ts-sdk/@microsoft/<module>/`.
  `docusaurus.config.ts` mirrors them into `docs/site/.ts-sdk-unified/`
  at config-load time and renders them through one Docusaurus docs plugin
  instance.
  Edit-this-page links are suppressed for TypeDoc-backed modules because
  the markdown is generated.

## Conventions

- Generated site output: `docs/site/build/`
- Cache invalidation: docs-site's `devDependencies` include
  `@rayfin/docgen` (which transitively pulls in every SDK package whose
  API reference is generated) plus `@microsoft/rayfin-guide` (handwritten
  content not covered by docgen). Rush's build cache therefore invalidates
  correctly when any documented package source changes.
- TS SDK route: `/docs/ts-sdk/<rayfin-module>` (all modules served by a
  single Docusaurus docs plugin against `.ts-sdk-unified/`).
- Shared landing route: `docusaurus.config.ts` computes `tsApiLandingPath`
  once and surfaces it via `siteConfig.customFields`; the navbar and the
  homepage CTAs read from the same value to prevent drift.
- Config: `onBrokenLinks: 'ignore'`; fix broken links in package-owned
  docs at the source package.
- Dependencies: from `docs/site`, run `rush add -p <pkg> --dev`.
