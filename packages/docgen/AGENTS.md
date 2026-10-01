# Typedoc AGENTS

Scope: TypeDoc configuration and generation for SDK API reference docs.
Generates markdown into `packages/docgen/dist/ts-sdk` which the Docusaurus
site at `docs/site` mirrors into its own staging directory at config-load
time.

## Commands

- Generate docs via docgen project: `rush build --to @rayfin/docgen`
- Validate the site that consumes them: `rush build --to docs-site`

## Source of Truth

- Config: `packages/docgen/typedoc.json`
- Landing page: `packages/docgen/README.md` (TypeDoc `readme` option)
- SDK inputs: each `entryPoints` directory under `packages/typescript-sdk/`
  with `entryPointStrategy: "packages"`. The current set covers `lib`,
  `core`, `client`, `auth`, `data`, `auth-provider-fabric`, `functions`,
  `connectors`, and `connector-fabric-semanticmodel`.
  `connector-kusto` and `storage` are excluded because they are marked
  `stability: "experimental"` in the docs catalog, and
  `docs/site/rayfin-docs-sources.ts` gates experimental packages out of the
  stable docs site; adding an entry point here would orphan the derived
  required-module check. `connector-fabric-graphql` is also excluded: it
  ships a hand-authored multi-page doc hub that the site mirrors in
  preference to generated output, so a TypeDoc entry point would drop its
  companion pages and break their relative links.
  `packages/udf/udf-worker-extension` (`@microsoft/fabric-user-data-functions`)
  ships a hand-authored api-reference hub at `assets/docs/` and **is** on the
  stable docs site — it carries no `stability` flag in the catalog, which is a
  docs classification and deliberately independent of the package's npm release
  channel. It is still not a TypeDoc entry point, for a
  different reason: it lives outside `packages/typescript-sdk/`, so the
  last-path-segment derivation would produce `rayfin-udf-worker-extension`
  rather than its `rayfinDocs.module` name `fabric-user-data-functions`, and the
  required-module check would be orphaned. Wiring it up means reconciling those
  two names, not just adding the path. Until then it takes the hand-authored
  fallback lane, like `auth-provider-fabric`.

## Generated Outputs

- `packages/docgen/dist/ts-sdk/@microsoft/<module>/**`
  (one subtree per TypeDoc entry point).
  **Do not hand-edit.**
- `docs/site/docusaurus.config.ts` mirrors each per-module subtree into
  `docs/site/.ts-sdk-unified/<module>/` at config-load time and serves the
  unified tree through a single Docusaurus docs plugin instance.

## Conventions

- Each TypeDoc entry point must be a directory whose last path segment maps
  to a `rayfin-<segment>` module declared in that package's `rayfinDocs`
  manifest.
  `docs/site/docusaurus.config.ts` derives the required-module set from
  `entryPoints` and fails the build if any derived name has no matching
  `rayfinDocs` api-reference source.
- The `entryPointStrategy` must stay `"packages"`; the docs-site derivation
  rejects any other strategy because the last-segment mapping no longer
  produces meaningful module names.
- To exclude one public export subpath from TypeDoc without changing its
  Node.js or TypeScript resolution, add `"typedoc": null` as the first
  condition for that subpath in the package's `exports` map. TypeDoc resolves
  that condition before `types` or `import`; normal consumers ignore it.
- Use external links in `packages/docgen/README.md` to avoid TypeDoc
  asset-copy warnings.
- Fix JSDoc/TSDoc `@param` names to match signatures if TypeDoc warns.

## Validation

1. `rush build --to @rayfin/docgen` - produces `dist/ts-sdk/@microsoft/<module>/`
   trees with at least an `index.md` per module.
2. `rush build --to docs-site` - mirrors them into the site and renders the
   unified SDK Reference.
   Throws if any required TypeDoc output is missing or empty.
