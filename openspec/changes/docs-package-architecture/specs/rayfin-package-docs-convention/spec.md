## ADDED Requirements

### Requirement: rayfinDocs Package Field

A package SHALL declare its docs to the `@microsoft/rayfin-docs` indexer by adding a `rayfinDocs` field to its
`package.json`. The presence of this field is the discovery signal; the field's contents tell the indexer where
the docs live, what kind they are, and what module identifier to use for citations.

#### Scenario: Field shape
- **WHEN** a package adds a `rayfinDocs` field to its `package.json`
- **THEN** the field SHALL be an object with the following keys:
  - `dir` (string, optional, default `"assets/docs"`): relative path from the package root to the docs
    directory; if present, it must be non-empty
  - `module` (string, required): short identifier used for citations and module filtering
  - `kind` (string, required): one of `"api-reference"`, `"guide"`, `"host"`
- **AND** the indexer SHALL validate the field's shape and reject malformed declarations

#### Scenario: Tarball includes docs directory
- **WHEN** a package declares `rayfinDocs.dir`
- **THEN** that directory SHALL be listed in the package's `files` array (or otherwise included in the
  publishable artifact) so the docs ship with the npm tarball

### Requirement: Per-Package Doc Versioning

Each package's docs SHALL ship inside that package's tarball at that package's published version. The version
of the displayed docs SHALL match the version of the installed package, by construction, with no separate
lockstep coordination required.

#### Scenario: Version matches package
- **WHEN** a Builder runs `npm install @microsoft/rayfin-core@1.30.0`
- **THEN** the docs at `node_modules/@microsoft/rayfin-core/assets/docs/` SHALL describe the 1.30.0 API
- **AND** any subsequent `rayfin-docs` query that surfaces a `rayfin-core` doc SHALL be describing the 1.30.0
  API

#### Scenario: Mixed versions
- **WHEN** a Builder has `@microsoft/rayfin-core@1.30.0` and `@microsoft/rayfin-data@1.20.0` installed
- **THEN** the indexer SHALL discover both packages
- **AND** core's docs SHALL describe 1.30.0; data's docs SHALL describe 1.20.0
- **AND** there SHALL be no spurious "lockstep mismatch" error — the indexer is version-agnostic about content

### Requirement: Coverage of typescript-sdk packages

Every typescript-sdk package on the lockstep policy SHALL declare a `rayfinDocs` field and ship per-package
docs by the end of Phase 3. This closes the current TypeDoc coverage gap.

#### Scenario: All lockstep SDK packages have docs
- **GIVEN** the typescript-sdk lockstep policy includes `rayfin-auth`, `rayfin-auth-provider-fabric`,
  `fabric-embedded-host`, `rayfin-client`, `rayfin-core`, `rayfin-data`, `rayfin-functions`, `rayfin-lib`,
  `rayfin-react`, `rayfin-storage`
- **WHEN** Phase 3 ships
- **THEN** every one of these packages SHALL declare `rayfinDocs` and ship at least an `assets/docs/index.md`
- **AND** packages with a public TypeScript surface (not `@deprecated`-marked or internal) SHALL ship
  TypeDoc-generated reference docs for that surface

### Requirement: Cross-cutting Builder content lives in `@microsoft/rayfin-guide`

Builder-facing guide content that spans multiple SDK packages SHALL live in a dedicated `@microsoft/rayfin-guide` package. The package SHALL declare `rayfinDocs` with `kind: "guide"` so it's discovered like any other docs source. Examples of cross-cutting content include `getting-started`, `auth/overview`, `data/permissions`, and CLI workflow guides.

#### Scenario: Guide content is a real npm package
- **WHEN** a Builder wants the high-level Builder guide
- **THEN** they SHALL be able to install `@microsoft/rayfin-guide` directly
- **AND** the indexer SHALL discover it via the same `rayfinDocs` mechanism used for SDK packages

#### Scenario: Guide content is also published to the Docusaurus site
- **WHEN** the docs site (`docs/site/`) builds
- **THEN** Docusaurus SHALL source guide content from `packages/guide/assets/docs/`
- **AND** the rendered site SHALL be equivalent to today's site (no Builder-visible regression)
