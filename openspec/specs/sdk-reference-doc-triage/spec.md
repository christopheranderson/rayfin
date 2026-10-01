# sdk-reference-doc-triage Specification

## Purpose

Define how the published TypeScript SDK reference (`fabric-apps-sdk-javascript` on Microsoft Learn)
is triaged so that it exposes only Builder-facing symbols, documents them fully, marks experimental
previews, and keeps the documentation build green — all without changing runtime behavior or the
exported API shape.

## Requirements

### Requirement: Published reference excludes non-Builder symbols

The published TypeScript SDK reference (`fabric-apps-sdk-javascript` on Microsoft Learn) SHALL expose only symbols that a Builder would reference, call, construct, or type-annotate against.
Every exported symbol and public member across the six published packages (`lib`, `core`, `client`, `auth`, `data`, `auth-provider-fabric`) that fails this test SHALL be tagged `@internal` so TypeDoc excludes it.

#### Scenario: Internal plumbing is hidden

- **WHEN** an exported symbol is internal-only (for example, an HTTP route-path constant such as `JWKS_PATH` or `TOKEN_PATH`)
- **THEN** it SHALL carry the `@internal` tag
- **AND** it SHALL NOT appear in the generated `packages/docgen/dist/ts-sdk` output after `rush build --to @rayfin/docgen`

#### Scenario: Builder-facing symbol stays published

- **WHEN** a symbol is one a Builder uses (for example, `ApiClient`, `SdkError`)
- **THEN** it SHALL NOT carry `@internal`
- **AND** it SHALL appear in the generated reference output

### Requirement: Builder-facing symbols are fully documented

Every symbol and public member that remains published SHALL carry a Builder-oriented TSDoc summary describing what it is and when a Builder uses it, plus `@param` for each parameter, `@returns` where a value is returned, and `@example` where usage is non-obvious.

#### Scenario: Documented method

- **WHEN** a published class exposes a public method a Builder calls
- **THEN** the method SHALL have a summary, a `@param` entry for each parameter whose name matches the signature, and a `@returns` entry when it returns a value

#### Scenario: Parameter names match the signature

- **WHEN** a `@param` tag is present
- **THEN** its name SHALL exactly match the corresponding parameter name in the signature
- **AND** `rush build --to @rayfin/docgen` SHALL succeed under `treatWarningsAsErrors: true`

### Requirement: Experimental exports are marked, not hidden

Symbols intended as Builder-visible previews (for example, exports under `experimental/` directories) SHALL be tagged `@experimental` and SHALL remain in the published reference.

#### Scenario: Experimental export remains visible

- **WHEN** an export resides under an `experimental/` directory and is intended for Builder preview use
- **THEN** it SHALL be tagged `@experimental`
- **AND** it SHALL NOT be tagged `@internal`
- **AND** it SHALL appear in the generated reference output

### Requirement: Docgen build gate is enforced per package

The triage pass SHALL keep the documentation build green at each package checkpoint and across the unified site.

#### Scenario: Per-package validation

- **WHEN** triage for a package is complete
- **THEN** `rush build --to @rayfin/docgen` SHALL succeed before the next package begins

#### Scenario: Unified site validation

- **WHEN** triage for all six packages is complete
- **THEN** `rush build --to docs-site` SHALL succeed and render the unified SDK reference

### Requirement: Triage is limited to documentation surface

The pass SHALL change only TSDoc comments and TSDoc tags (`@internal`, `@experimental`, `@param`, `@returns`, `@example`).
It SHALL NOT change runtime behavior, exported API shape, or the set of exported symbols.

#### Scenario: No behavioral change

- **WHEN** the triage edits are applied to an SDK package
- **THEN** the package's exported symbols and their signatures SHALL remain unchanged
- **AND** only comments and TSDoc tags SHALL differ
