# rayfin-cli-init Specification

## Purpose

`rayfin init` is the primary project initialization command for the Rayfin platform.
It handles:

- Blank project configuration (`rayfin.yml`, `.gitignore`, `AGENTS.md`)
- Template-based scaffolding from bundled templates
- External template sources via `-t <url>` (git URLs, local paths)
- Template catalog navigation
- Parameterized template rendering
- Agent-friendly discovery and non-interactive scaffolding
- `--from-template` post-scaffold synchronization (called by `create-rayfin`)

## Requirements

### Requirement: Force Overwrite Option

The `rayfin init` command SHALL support a hidden `--from-template` flag that synchronizes the rayfin-managed scaffold files without prompting and without destroying template-author or user customizations. The flag is used by `create-rayfin` (and the post-scaffold pipeline) to keep external templates in sync with rayfin-managed assets while preserving the template author's intent.

**Important**: The flag affects exactly the files that `rayfin init` currently prompts about when they exist:

- ✅ **Merge into existing**: `.gitignore` (at the project root). The canonical Rayfin patterns from `assets/.gitignore.template` are appended only when missing, under a labeled `# Added by Rayfin CLI` section. Template-author and user lines are preserved verbatim. Idempotent: re-running on a fully covered file leaves the bytes unchanged.
- ✅ **Apply minimum identity edits**: `rayfin.yml`. Only `name`/`id` (when `--project-name` differs from the template's authored name) and `services.data.dialect` (when `--dialect` is passed and the template ships a `services.data` block) are written. Every other top-level key — including the entire `services` block the template author chose — is preserved by **value and shape**. Note: when an identity edit fires, the file is written via YAML parse + stringify, which preserves values but drops authored comments and authored whitespace outside the edited keys; bytes are preserved exactly only when no edit is required (the implementation early-returns without writing).
- No other files are affected by this flag

Additionally, when artifact context flags (`--workspace-id`, `--item-id`) are provided alongside `--from-template`, the system SHALL pre-seed deployment metadata.

#### Scenario: Merge .gitignore preserves template-author lines

- **WHEN** a user runs `rayfin init --from-template` and a project-root `.gitignore` already exists
- **THEN** the system appends only the canonical Rayfin patterns that are missing under a `# Added by Rayfin CLI` header
- **AND** every line the template author or user previously authored is preserved
- **AND** any existing `rayfin.yml` is preserved with at most identity-only edits (see "Preserve existing rayfin.yml")

#### Scenario: Preserve existing rayfin.yml

- **WHEN** a user runs `rayfin init --from-template` and `rayfin.yml` already exists
- **THEN** the system preserves the existing `rayfin.yml` configuration values and shape, except for the minimum identity edits documented above (`name`/`id` when renaming, `services.data.dialect` when `--dialect` is passed). When no identity edit is required the file is not rewritten and bytes are preserved exactly; when an identity edit fires, values and shape are preserved but authored comments and whitespace outside the edited keys are not.
- **AND** the existing `services` block — including any auth, data, storage, staticHosting, or functions configuration the template author authored — is preserved by value and shape, without injecting default fields
- **AND** the `.gitignore` is merged (not overwritten) when present

#### Scenario: Idempotent re-run leaves managed files unchanged

- **WHEN** `rayfin init --from-template` runs against a project whose `.gitignore` already covers every canonical Rayfin pattern and whose `rayfin.yml` already has a name matching `--project-name`
- **THEN** neither file is rewritten (byte-for-byte identical before and after)

#### Scenario: create-rayfin template synchronization

- **WHEN** `create-rayfin` CLI runs `rayfin init --from-template` to update template scaffolding
- **THEN** missing canonical Rayfin patterns are merged into the project-root `.gitignore`
- **AND** the template's custom `rayfin.yml` configuration is preserved (only identity edits applied)
- **AND** the command completes without requiring user input
- **AND** no other files beyond those normally prompted are affected

#### Scenario: From-template with artifact context

- **WHEN** `create-rayfin` CLI runs `rayfin init --from-template --workspace-id ws-123 --item-id item-456`
- **THEN** missing canonical Rayfin patterns are merged into the project-root `.gitignore`
- **AND** the template's custom `rayfin.yml` configuration is preserved (only identity edits applied)
- **AND** `.env.fabric` is created with the provided workspace and artifact IDs

#### Scenario: Normal interactive behavior without flag

- **WHEN** a user runs `rayfin init` without the `--from-template` flag and a project-root `.gitignore` already exists
- **THEN** the system prompts the user whether to overwrite `.gitignore` (clobber semantics on consent — this path is the user's explicit choice, not a sync)
- **AND** any existing `rayfin.yml` is always preserved without prompting

### Requirement: Database Dialect Flag

The `rayfin init` command SHALL support a hidden `--dialect` flag that allows automation tools to specify the database dialect when generating or updating `rayfin.yml`.

#### Scenario: Accept dialect flag

- **WHEN** user runs `rayfin init --dialect mssql`
- **THEN** the system accepts the flag without error
- **AND** generates `rayfin.yml` with `services.data.dialect: mssql`

#### Scenario: Accept postgresql dialect

- **WHEN** user runs `rayfin init --dialect postgresql`
- **THEN** the system generates `rayfin.yml` with `services.data.dialect: postgresql`

#### Scenario: Normalize dialect value

- **WHEN** user provides `--dialect MSSQL` or `--dialect PostgreSQL` with uppercase letters
- **THEN** the system normalizes the value to lowercase
- **AND** stores "mssql" or "postgresql" in `rayfin.yml`

#### Scenario: Dialect flag is hidden from help

- **WHEN** user runs `rayfin init --help`
- **THEN** the `--dialect` flag is not displayed in the help output
- **AND** the flag remains available for programmatic use

#### Scenario: Dialect only applied when data service enabled

- **WHEN** user runs `rayfin init --dialect postgresql`
- **AND** data service is not selected in the services prompt
- **THEN** the system does not include `dialect` field in `rayfin.yml`

#### Scenario: Default to MSSQL when no dialect specified

- **WHEN** user runs `rayfin init` without `--dialect` flag
- **AND** data service is enabled
- **THEN** the system defaults to MSSQL dialect (existing behavior)

### Requirement: Dialect Preservation with From-Template Flag

The `rayfin init --from-template` command SHALL treat `--dialect` as an explicit user opt-in to update the dialect — it is one of the minimum identity edits the from-template synchronization is allowed to make. Without `--dialect`, the existing dialect is preserved.

#### Scenario: Apply provided dialect when --dialect is passed and template has a data block

- **WHEN** user runs `rayfin init --from-template --dialect postgresql`
- **AND** `rayfin.yml` already exists with `services.data.dialect: mssql`
- **THEN** the system updates `services.data.dialect` to `postgresql` (the user explicitly opted in via the flag)
- **AND** every other field in `services.data` and the rest of `rayfin.yml` is preserved by value and shape (the YAML is rewritten via parse + stringify when this identity edit fires, so authored comments and whitespace outside the edited key are not byte-preserved; values match what the template author authored)

#### Scenario: Use provided dialect when not present in existing config

- **WHEN** user runs `rayfin init --from-template --dialect postgresql`
- **AND** `rayfin.yml` already exists but does not have `services.data.dialect` field
- **THEN** the system adds `dialect: postgresql` to the existing `services.data` configuration

#### Scenario: Warn when --dialect cannot be applied (no services.data block)

- **WHEN** user runs `rayfin init --from-template --dialect postgresql`
- **AND** `rayfin.yml` already exists but has no `services.data` block at all (the template did not enable the data service)
- **THEN** the system does NOT synthesize a `services.data` block (that would inject default scaffolding the template explicitly opted out of)
- **AND** the system emits a warning explaining that `--dialect` was ignored because the template has no data block

#### Scenario: Use provided dialect for new projects

- **WHEN** user runs `rayfin init --from-template --dialect postgresql`
- **AND** `rayfin.yml` does not exist
- **THEN** the system creates new `rayfin.yml` with `services.data.dialect: postgresql`

#### Scenario: Preserve dialect without flag

- **WHEN** user runs `rayfin init --from-template` without `--dialect` flag
- **AND** `rayfin.yml` already exists with configured dialect
- **THEN** the system preserves the existing dialect value (existing behavior)

### Requirement: Template-based scaffolding

The `rayfin init` command SHALL support template-based project scaffolding from bundled and registry template sources.

#### Scenario: Show template picker when no source specified

- **WHEN** user runs `rayfin init` without `-t` flag
- **THEN** the system presents an interactive picker with three options: "Use a template" (bundled), "Use an external git template" (URL), and "Start from scratch" (configure manually)

Note: The three-option picker separates bundled templates from external git URLs for a clearer UX.

#### Scenario: Use a template shows bundled templates

- **WHEN** user selects "Use a template"
- **THEN** the system displays bundled templates for selection

#### Scenario: Use an external git template prompts for URL

- **WHEN** user selects "Use an external git template"
- **THEN** the system prompts for a git URL and scaffolds from the external source

#### Scenario: Start from scratch continues with config wizard

- **WHEN** user selects "Start from scratch"
- **THEN** the system continues with the existing blank project configuration wizard

### Requirement: External template sources

The `rayfin init` command SHALL accept external template sources via the `-t`/`--template` flag.
The value can be a git URL, a local filesystem path, or a built-in template name.
Resolution order: if the value matches a known built-in template, use that; otherwise treat as a URL or local path.
CLI-shipped first-class registry aliases are an exception: the alias routes to its allow-listed registry template before using the bundled template with the same name as fallback.

For full template source resolution, manifest format, and security requirements, see the [external-template-sources spec](../external-template-sources/spec.md).

#### Scenario: Accept git URL as template source

- **WHEN** user runs `rayfin init -t https://github.com/org/template-repo`
- **THEN** the system clones the repository to a persistent cache
- **AND** discovers templates via `rayfin-template.yml` manifests

#### Scenario: Accept local path as template source

- **WHEN** user runs `rayfin init -t ./my-templates`
- **THEN** the system reads templates from the local directory
- **AND** discovers templates via `rayfin-template.yml` manifests

#### Scenario: Support single-entry manifest

- **WHEN** the template source contains a `rayfin-template.yml` with a single entry
- **THEN** the system auto-selects that template without presenting a picker

#### Scenario: Support multi-entry manifest

- **WHEN** the template source contains a `rayfin-template.yml` with multiple entries
- **THEN** the system presents a flat picker for the user to choose a template
- **AND** this behavior applies to both external git template sources and local directory template sources
- **AND** when the manifest contains grouped entries, the picker navigates through groups using breadcrumb navigation before selecting a leaf template

### Requirement: Agent-friendly template discovery

The `rayfin init` command SHALL support non-interactive flags for CI/CD and agent-based workflows.

> **Partially deferred:** `--list-templates` ships in this changeset. `--describe`, `--config`, and `--param` are deferred to the parameterization follow-up. The full agent workflow is documented here for future implementation.

#### Agent workflow

The recommended agent workflow is: discover → inspect → scaffold.

```text
1. rayfin init --list-templates                                    → discover available templates  (✅ shipped)
2. rayfin init --template <name-or-url> --describe                 → inspect template params       (📋 deferred)
3. rayfin init --template <name-or-url> --param k=v --param k2=v2  → scaffold                      (📋 deferred)
```

For catalogs:

```text
1. rayfin init --template <catalog-url> --describe                             → list catalog entries   (📋 deferred)
2. rayfin init --template <catalog-url> --template-name foo --describe         → inspect specific       (📋 deferred)
3. rayfin init --template <catalog-url> --template-name foo --param k=v        → scaffold               (📋 deferred)
```

#### Scenario: List available templates as JSON

- **WHEN** user runs `rayfin init -l` (or `--list-templates`)
- **THEN** the system outputs JSON containing all available templates
- **AND** the output includes both bundled and registry-sourced templates
- **AND** registry entries include provenance (the registry name)
- **AND** first-class registry entries appear in the bundled list as built-in templates

#### Scenario: Describe a template by name or URL (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** user runs `rayfin init --template <name-or-url> --describe`
- **AND** the target is a template manifest
- **THEN** the system outputs JSON with template metadata and parameters

`--describe` uses the same resolution order as `--template`: built-in name → registry name → git URL.

#### Scenario: Describe a catalog (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** user runs `rayfin init --template <catalog-url> --describe`
- **AND** the target is a catalog manifest
- **THEN** the system outputs JSON with catalog entries (name, displayName, description, path)

#### Scenario: Describe a template within a catalog (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** user runs `rayfin init --template <catalog-url> --template-name foo --describe`
- **THEN** the system outputs JSON with that template's metadata and parameters

#### Scenario: Describe without --template exits with error (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** user runs `rayfin init --describe` without `--template`
- **THEN** the system exits with a non-zero code
- **AND** the error message indicates `--describe` requires `--template`

#### Scenario: Describe output includes version field (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** the system outputs `--describe` JSON
- **THEN** the output includes a `version` field for schema compatibility

Note: `--describe` is implemented alongside parameters in the parameterization follow-up changeset.
The output shape will include `parameters` array with name, type, required, default, choices, and validation rules.

#### Scenario: Accept JSON config file for bulk parameters (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** user runs `rayfin init --config params.json`
- **THEN** the system reads parameter values from the JSON file

#### Scenario: Accept inline JSON config (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** user runs `rayfin init --config '{"key": "value"}'`
- **THEN** the system parses inline JSON for parameter values

#### Scenario: Accept individual parameter overrides (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** user runs `rayfin init --param key=value`
- **THEN** the system sets the specified parameter value

#### Scenario: Missing required parameter exits with error (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** user runs `rayfin init --template <url> --param key=value`
- **AND** the template has a required parameter that was not provided
- **THEN** the system exits with a non-zero code
- **AND** the error message lists the missing required parameter(s)

#### Scenario: Invalid parameter value exits with error (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** user runs `rayfin init --template <url> --param key=invalid`
- **AND** the value fails the parameter's validation rules
- **THEN** the system exits with a non-zero code
- **AND** the error message describes the validation failure

#### Scenario: Non-interactive catalog selection

- **WHEN** user runs `rayfin init -t <catalog-url> --template-name my-template`
- **THEN** the system selects the named template from the catalog without presenting the picker

Note: `--template-name` is only used to select within a catalog.
To use a built-in template by name, use `--template <name>` directly.

### Requirement: Exit codes

The `rayfin init` command SHALL use consistent exit codes for agent consumption.

| Exit code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | General error (invalid args, missing template, scaffold failure) |
| 2 | User cancelled scaffolding (e.g. declined overwrite); distinct from 1 so consumers can tell user-decline from crash. Applies to all three template sources: bundled, external (`-t <git-url>`), and local (`-t <path>`). |
| 3 | `rayfin init ai-files install` succeeded but raised warnings (e.g. user-modified items preserved, malformed sibling file). Distinct from 1 so agent consumers can tell warning-only success from a hard error. |

#### Scenario: User-cancelled scaffold exits 2

- **WHEN** user runs `rayfin init` (with any template source — bundled `--template <name>`, external `-t <git-url>`, or local `-t <path>`) and any of the following:
  - declines the overwrite prompt against a non-empty target directory (whether named or in-place `.`)
  - runs without `--overwrite` in non-interactive mode against a non-empty target
  - declines the Copilot CLI install prompt when scaffolding the synthetic Copilot template (bundled flow only)
- **THEN** the process exits with code 2
- **AND** the wrapper (`create-rayfin` or `rayfin` itself) records the invocation as `Canceled` in telemetry, not `Failure`
- **AND** no Fabric env override is persisted into the (untouched) target directory

### Requirement: Unified template source resolution

The `--template` flag resolution and the interactive picker SHALL share a single resolution pipeline that handles bundled templates, external git URLs, registry entries, and local paths.

#### Scenario: Template resolution handles all source types

- **WHEN** user provides `--template <value>`
- **THEN** the system resolves the value through a single resolution pipeline: first-class registry alias → bundled name → registry name → git URL → local path
- **AND** the interactive picker uses the same resolution pipeline

### Requirement: Shared scaffold lifecycle

The bundled, external, and local template flows SHALL share a single post-scaffold pipeline (`runScaffoldPipeline` in `packages/tools/cli/src/utils/scaffold-pipeline.ts`) that owns: project-name customization, dependency install (guarded on `package.json` presence), `rayfin init --from-template` synchronization, optional Copilot session, and optional Fabric env override persistence.

All three handlers SHALL also share helpers for the pre-scaffold conflict check (`checkTargetConflict`), pre-scaffold wipe (`wipeTargetDirectory`), template instantiation reporting (`instantiateAndReport`), and cleanup-on-failure (`cleanupPartialScaffold`).

The conflict check SHALL treat a pre-existing **empty** target directory the same as a non-existent one: proceed silently, no overwrite prompt, and no `--overwrite` consent required. Only a directory containing one or more entries is a conflict. This applies to both the wrapper (`checkTargetConflict`) and the inner prompt helper (`checkDirectoryConflict`) so the two layers cannot drift.

"Empty" means `readdirSync` returns zero entries (no files, no subdirectories, no dotfiles). A pre-existing target containing only `.git/` (a pre-`git init`'d folder), `.DS_Store`, `.gitkeep`, or any other dotfile/metadata entry is considered **non-empty** and SHALL trigger the conflict prompt. Treating VCS or OS metadata as "effectively empty" is explicitly out of scope and tracked separately if desired.

#### Scenario: Single scaffold pipeline across all template sources

- **WHEN** any of `rayfin init` (bundled), `rayfin init -t <git-url>` (external), or `rayfin init -t <local-path>` (local) runs successfully
- **THEN** all three invoke the same `runScaffoldPipeline` for post-scaffold work
- **AND** the same set of flags (`--project-name`, `--dialect`, `--workspace-id`, `--item-id`, `--skip-install`, `--base-api-url`) reaches the pipeline regardless of which source was selected

#### Scenario: Wipe deferred until after source validation

- **WHEN** the user passes `--overwrite` against a non-empty pre-existing target directory
- **AND** the new template source fails to clone, parse, or resolve (network error, manifest invalid, etc.)
- **THEN** the user's pre-existing data is preserved (the wipe is deferred until after the source is validated, so a failure between consent and scaffold does not destroy data)

#### Scenario: Empty pre-existing target directory proceeds without prompting

- **WHEN** the user runs `rayfin init my-app` (or any template variant) against a `my-app/` directory that exists but is empty
- **THEN** the system SHALL proceed with scaffolding without prompting for overwrite confirmation
- **AND** SHALL NOT require the `--overwrite` flag in non-interactive mode (when `--yes` is set, when stdin is not a TTY, or when `CI=true` — i.e., whenever `isInteractive()` returns false)
- **AND** SHALL NOT emit the `is not empty and overwrite was declined` cancellation message

### Requirement: Unified template entry selection

The external (git) and local template flows SHALL share a single entry selector (`selectTemplateEntry` in `packages/tools/cli/src/utils/template-entry-selector.ts`) that resolves one leaf template from a parsed manifest.
The selector SHALL support flat and grouped manifests and SHALL resolve chosen leaves through the hardened path validator (`resolveEntryPath`, including realpath and symlink-escape checks).

#### Scenario: Grouped local manifest navigates interactively

- **WHEN** the user runs `rayfin init -t <local-path>` interactively
- **AND** the local manifest contains grouped entries
- **THEN** the system presents breadcrumb navigation through groups via `navigateCatalog`
- **AND** the navigation behavior matches a git-backed catalog with the same manifest shape

#### Scenario: Template name resolves grouped leaves non-interactively

- **WHEN** the user runs `rayfin init -t <local-or-git-source> --template-name <leaf>`
- **AND** the manifest contains grouped entries
- **THEN** the system resolves `<leaf>` across flattened entries from `flattenManifestEntries`
- **AND** the system resolves the selected leaf without presenting a picker

#### Scenario: Template name falls back to path match

- **WHEN** `--template-name <value>` does not match a flattened leaf name
- **AND** `<value>` matches a flattened leaf path
- **THEN** the system proceeds with the path-matched leaf
- **AND** the system emits the warning `No template named '<value>' — matched by path instead`

#### Scenario: Ambiguous template name exits with matching entries

- **WHEN** `--template-name <value>` matches multiple flattened leaves
- **THEN** the system exits with code 1
- **AND** the error lists each matching entry as `displayPath > ... (templatePath)`

#### Scenario: Single leaf manifest auto-selects

- **WHEN** the parsed manifest flattens to one leaf template
- **THEN** the selector auto-selects that leaf without presenting a picker
- **AND** this is the behavior described in the "Support single-entry manifest" scenario

#### Scenario: Non-interactive multi-entry source requires template name

- **WHEN** the user runs `rayfin init -t <local-or-git-source> --yes`
- **AND** the parsed manifest flattens to multiple leaves
- **AND** the user does not pass `--template-name`
- **THEN** the system exits with code 1
- **AND** the error lists available templates
- **AND** the error includes the recovery hint to run interactively, pass `--template-name <name>`, or specify a single-entry template

### Requirement: Scaffold-source-agnostic Rayfin output

`rayfin init` is a Rayfin scaffolding command. Regardless of whether the source is a bundled template, an external git URL, or a local path, the resulting project SHALL be a Rayfin project: the post-scaffold pipeline runs unconditionally and produces `rayfin/rayfin.yml`, `rayfin/tsconfig.json`, `rayfin/.env`, and (when artifact context is provided) `rayfin/.deployments.json`. A project-root `.gitignore` SHALL be written by the post-scaffold pipeline as well (see "Project-root .gitignore" requirement); the inner `rayfin/.gitignore` SHALL NOT be produced by `init.ts` (samples may still ship one in the local-template flow, but it has no canonical writer in the published path because `npm pack` strips it).

This is intentional. `rayfin init -t <url>` means "give me a Rayfin project from this source." Users who want a plain clone without Rayfin overlay should use `git clone` directly — the choice of `rayfin init` as the entry point is the user's explicit opt-in.

The `package.json.name` field SHALL be rewritten to the slugified user-supplied project name (`--project-name` value, or directory basename when omitted). This matches the convention of every other modern scaffolding tool — `npm create vite`, `create-next-app`, `rails new`, `cargo new` all rewrite the package identifier to the new project's name. Templates that ship a placeholder name (`"placeholder"`, `"@scope/template-name"`, etc.) have it replaced with the user's project name; the scaffold serves the user's intent for the new project, not the template author's intent for the source.

#### Scenario: External template produces a populated rayfin.yml

- **WHEN** a user runs `rayfin init -t <git-url> --project-name foo target-dir`
- **AND** the external template ships only a `package.json` (no `rayfin.yml`)
- **THEN** the resulting `target-dir/rayfin/rayfin.yml` is created with `name: foo` and `id: foo`
- **AND** `target-dir/package.json.name` is rewritten to `foo`

#### Scenario: External Rayfin-shaped template preserves rayfin.yml

- **WHEN** a user runs `rayfin init -t <git-url>` against an external template that already ships `rayfin/rayfin.yml`
- **THEN** the existing `rayfin.yml` is preserved (only minimum identity edits applied per the "Force Overwrite Option" requirement: `name`/`id` when renaming, `services.data.dialect` when `--dialect` is passed)
- **AND** the template author's `services` block — including any auth, data, storage, staticHosting, or functions configuration they authored — survives without injecting default fields the template never opted into
- **AND** the surrounding scaffold files (`rayfin/tsconfig.json`, `.temp/docker-compose.yml`) are still produced
- **AND** the project-root `.gitignore` is merged with the canonical asset content (template-author lines preserved, missing canonical patterns appended)

#### Scenario: package.json.name from template is rewritten

- **WHEN** an external template's `package.json` declares `"name": "@acme/template"` (or any other deliberate value)
- **AND** a user runs `rayfin init -t <url> --project-name my-clone target-dir`
- **THEN** `target-dir/package.json.name` is `"my-clone"` (the user's project, not the template's identity)

> **Note:** Some duplication remains across `init-bundled-template.ts` and `init-external-template.ts`. A future refactor will extract a fully shared helper to centralize the lifecycle. For now, both flows implement: conflict prompt for non-empty pre-existing targets, staging+rename for new directories, partial output cleanup on failure (gated on `inPlace`).

### Requirement: ai-files subcommand group

The `rayfin init` command SHALL expose an `ai-files` subcommand group that manages Rayfin agent-context files (`AGENTS.md`, `.mcp.json` `mcpServers.rayfin`, `.agents/skills/rayfin/SKILL.md`) in a scaffolded project.
The subcommand group is reachable as `rayfin init ai-files <subcommand>` (not as a top-level `rayfin ai-files`) because agent-file lifecycle is conceptually scoped to project initialization.

State is recorded in `rayfin/.lockfile.json` — a project-tracked lockfile inside the existing `rayfin/` configuration directory.

The lockfile shape is namespace-extensible: every entry under `items` is keyed by `<namespace>:<name>` (e.g. `skill:rayfin`, `mcp:rayfin`). New CLI concerns can adopt the same shape — either by adding new namespaces to this file or by writing their own file with the same `Lockfile` schema — without breaking existing consumers.

#### Subcommands

| Subcommand | Behavior |
| --- | --- |
| `rayfin init ai-files install` | Install or refresh Rayfin agent files. **Idempotent** — re-running auto-reconciles the project to the current bundled content (auto-update on content drift, install newly-shipped descriptors, clean up orphans). On a fresh project, also bootstraps `AGENTS.md`. Interactive when stdin is a TTY and no per-item flags are passed. |
| `rayfin init ai-files status` | Prints a one-line-per-item state summary (`up-to-date`, `update-available`, `user-modified`, `missing`, `disabled`, `orphaned`, `unreadable`). Pass `--json` to emit a structured JSON object on stdout for programmatic consumers. |

`install` accepts the following flags:

| Flag | Behavior |
| --- | --- |
| `--enable <id>` (repeatable) | Enable a managed item by its namespaced id (e.g. `--enable skill:rayfin`). Unknown ids are rejected at the CLI boundary. |
| `--disable <id>` (repeatable) | Disable a managed item — the CLI stops managing it but does not delete from disk by default. Also accepts orphan ids (items in the lockfile that the current CLI no longer ships). |
| `--remove-files` | Modifier for `--disable`. When set, on-disk content is removed in addition to being marked disabled. Cannot be passed without `--disable`. |
| `--force [ids...]` (variadic) | Overwrite existing items per the conflict matrix below. With no args (`--force`), applies to every managed item (legacy global behavior). With one or more namespaced ids (`--force mcp:rayfin`), scopes force to those items only — other items use default behavior (warn instead of overwrite). Unknown ids are rejected at the CLI boundary. Does not overwrite `AGENTS.md` (one-time install). |
| `--json` | Emit a single JSON envelope `{ status, schemaVersion, dryRun, report }` to stdout instead of human-formatted progress lines. Implies non-interactive (suppresses the picker). |
| `--dry-run` | Classify what install would do and emit the report without touching disk. Pairs with `--json` for previewability in scripts. |
| `-y, --yes` / `--non-interactive` | Skip the interactive prompt. `-y/--yes` is registered both globally (`rayfin --yes init ...`) AND locally on the install command (`rayfin init ai-files install --yes`); both forms work. |

`--enable` and `--disable` for the same id in one invocation is rejected as an error.

#### Subcommand exit codes

| Exit code | Meaning |
| --- | --- |
| 0 | Success, no warnings |
| 1 | Hard error (invalid args, unknown id, malformed lockfile, write failure that wasn't isolated by per-item handling) |
| 3 | Success but warnings present (`user-modified` items preserved, `unreadable` sibling files, etc.). Distinct from 1 so agent consumers can distinguish "you should look at this" from "the command failed." |

#### Sha-based versioning

Update decisions are gated on **content sha equality**, not CLI version:

- `update-available` ⟺ recorded sha ≠ sha of currently-bundled content.
- `up-to-date` ⟺ recorded sha = sha of currently-bundled content AND on-disk file matches recorded sha.

This decouples update cadence from CLI release cadence: a CLI version bump that does not change bundled content does not produce drift nags. The lockfile records the top-level `cliVersion` for diagnostics only.

The `rayfin dev` drift nudge text reflects this — it talks about content drift, not version drift, to avoid teaching a version-based mental model the decision gate explicitly rejected.

#### Conflict matrix — `install`

`install` is the single lifecycle command. Re-runs auto-reconcile by re-writing items whose bundled content has changed, installing newly-shipped descriptors, and cleaning up orphans.

| State | Default | With `--force` |
| --- | --- | --- |
| not-installed | install | install |
| up-to-date | no-op | no-op |
| update-available | rewrite (bundled content changed) | rewrite |
| user-modified | warn, preserve user content | overwrite with bundled |
| missing | warn | re-install |
| disabled (lockfile flag) | skip | skip — `--force` alone does NOT re-enable; pass `--enable <id>` to clear the flag |
| disabled (sigil-removed skill) | skip | skip — pass `--enable <id> --force` to re-stamp the sigil and overwrite |
| unreadable | warn | overwrite (rebuilds from `{}` for malformed `.mcp.json`) |
| orphaned (clean) | delete (lockfile + disk) | delete |
| orphaned (dirty) | warn, preserve | delete |
| orphaned + `--disable <id>` | mark disabled, preserve file (does NOT enter cleanup) | mark disabled, preserve file |
| orphaned + `--enable <id>` | warning: descriptor is gone, cannot re-enable | warning |

`AGENTS.md` is one-time install. `--force` does NOT overwrite an existing `AGENTS.md`. Whoever wrote it first (template or default) keeps it.

The `With --force` column applies whether `--force` was passed globally (no args) or scoped to that specific id (`--force <id>`). For a scoped run, items not listed continue to follow the `Default` column.

#### Warning resolution

When `install` encounters a state that needs user attention (`user-modified`, `missing`, `unreadable`, or `orphaned (dirty)`), the command logs a warning to stderr with explicit next-step instructions and exits with a non-zero status.
Warnings do not block the command — other items proceed normally.

The next-step instructions in each warning recommend the **per-item form** of `--force`/`--disable` (e.g. `rayfin init ai-files install --force <id>` rather than the bare global form). This minimizes blast radius when a project has multiple warning-state items at once — a user resolving one conflict should not have to think about whether the resolution will collaterally overwrite an unrelated user-modified item in the same run.

The user resolves by re-running with `--force <id>` (overwrite a specific item with bundled), `--force` (overwrite every managed item), `--disable <id>` (stop managing — non-destructive by default; pass `--remove-files` to also delete from disk), or by repairing the file by hand for `unreadable` cases.

When `install` runs interactively (TTY + no per-item flags + no `--yes`), warning-state items are surfaced inline as annotations in the checkbox prompt.

#### Scenario: install creates all files on a clean project

- **WHEN** the user runs `rayfin init ai-files install --yes` in a project with no existing agent files
- **THEN** the system writes `AGENTS.md`, `.mcp.json` with `mcpServers.rayfin`, `.agents/skills/rayfin/SKILL.md`, and `rayfin/.lockfile.json`
- **AND** the command exits 0

#### Scenario: install is idempotent on subsequent runs

- **WHEN** the user runs `rayfin init ai-files install` again on a project where everything is up-to-date
- **THEN** the system reports `✓ Up to date` and writes nothing
- **AND** the command exits 0

#### Scenario: install auto-reconciles content drift

- **WHEN** the user upgrades the CLI to a version that ships changed bundled content (different sha)
- **AND** runs `rayfin init ai-files install`
- **THEN** the system detects `update-available` for items whose bundled sha differs from the recorded sha
- **AND** rewrites those items from the new bundled content
- **AND** the on-disk file's recorded sha is updated in the lockfile

#### Scenario: install does not silently overwrite pre-existing user content

- **WHEN** the user runs `rayfin init ai-files install` in a project that already has untracked content at one of the canonical Rayfin paths
- **THEN** the system warns about the user-modified item and exits non-zero
- **AND** does not overwrite the user's content
- **EXCEPT** when `--force` is passed, in which case the bundled content replaces the user's content

#### Scenario: per-item --force scoping

- **WHEN** the user runs `rayfin init ai-files install --force mcp:rayfin` in a project where both `mcp:rayfin` and `skill:rayfin` are `user-modified`
- **THEN** the system overwrites `mcp:rayfin` with the bundled content
- **AND** preserves the user-modified `skill:rayfin` and continues to warn about it (default behavior for items not listed after `--force`)
- **AND** the same is true for any subset of namespaced ids passed after `--force` (variadic)
- **AND** unknown ids passed after `--force` are rejected at the CLI boundary with a clear error

#### Scenario: warning text recommends the per-item resolution

- **WHEN** `install` emits a warning for a `user-modified`, `missing`, or `unreadable` item
- **THEN** the warning's next-step instructions reference `rayfin init ai-files install --force <id>` (per-item form) for the listed item rather than a bare `--force`
- **AND** the warning also references `rayfin init ai-files install --disable <id>` for the listed item where disabling is a valid resolution
- **SO THAT** following the warning's instruction never overwrites or disables an unrelated managed item in the same run

#### Scenario: AGENTS.md is one-time install

- **WHEN** `AGENTS.md` already exists in the project
- **THEN** the system preserves it on every `install` invocation
- **AND** even `--force` does not overwrite it (whoever owns it first — template or default — keeps it)

#### Scenario: removing the rayfin-managed sigil relinquishes CLI ownership

- **WHEN** the user removes `rayfin-managed: true` from `.agents/skills/rayfin/SKILL.md`'s frontmatter
- **THEN** subsequent `status` reports the skill as `disabled`
- **AND** `install --force` does not re-stamp the sigil unless `--enable skill:rayfin` is also passed

#### Scenario: scaffold pipeline auto-installs ai-files

- **WHEN** the user runs `rayfin init` (any template source: bundled, external, local — including the "Start from scratch" picker option) and the scaffold completes successfully
- **THEN** the system invokes the `ai-files install` flow against the scaffolded directory non-interactively
- **AND** failures during the post-scaffold install do not abort the init flow (best-effort with a warning)

#### Scenario: rayfin dev surfaces drift

- **WHEN** the user runs `rayfin dev` in a project where any managed item is `update-available`, `user-modified`, `missing`, or `unreadable`
- **THEN** the system prints a one-line drift nudge directing the user to `rayfin init ai-files install`

#### Scenario: CLI version bump alone does not produce drift

- **WHEN** the user upgrades `@microsoft/rayfin-cli` to a newer version that ships identical bundled content
- **AND** runs `rayfin dev` or `rayfin init ai-files status`
- **THEN** the system reports all items as `up-to-date`
- **AND** `rayfin dev` does not print a drift nudge

#### Scenario: disable a managed item without deleting it

- **WHEN** the user runs `rayfin init ai-files install --disable mcp:rayfin`
- **THEN** the lockfile records `mcp:rayfin` as disabled
- **AND** the on-disk `.mcp.json` `mcpServers.rayfin` value is preserved
- **AND** subsequent `install` invocations skip the item

#### Scenario: disable and remove from disk

- **WHEN** the user runs `rayfin init ai-files install --disable skill:rayfin --remove-files`
- **THEN** the lockfile records `skill:rayfin` as disabled
- **AND** the `.agents/skills/rayfin/` directory is removed from disk

#### Scenario: re-enable a disabled item

- **WHEN** the user runs `rayfin init ai-files install --enable skill:rayfin` on an item previously disabled with `--remove-files`
- **THEN** the system installs the bundled content fresh
- **AND** the item is no longer marked disabled in the lockfile

#### Scenario: disable at install time

- **WHEN** the user runs `rayfin init ai-files install --disable mcp:rayfin --yes`
- **THEN** the lockfile records `mcp:rayfin` as disabled with `sha256: null`
- **AND** the on-disk `.mcp.json` is not modified for the rayfin entry
- **AND** other items (skill, AGENTS.md) install normally

### Requirement: Positional argument doubles as project name

When a user provides an explicit positional directory argument that is not an in-place form (`.`, `./`, or any path that resolves to cwd), the system SHALL use the positional's basename as the resolved project name and SHALL skip the project-name prompt entirely.

The display form of the basename is preserved on `rayfin.yml.name` (e.g., `"My App"` stays `"My App"`).
The slugified form is used for `rayfin.yml.id` and `package.json.name` (e.g., `"my-app"`).

The `--project-name <name>` flag continues to override the project name (only the project name, not the directory).

When the basename does not pass `isValidProjectName`, the system SHALL fall back to a safe prompt default (`"My Rayfin App"`) instead of passing the invalid string through to downstream validation.

#### Scenario: Skip prompt for valid bare-name positional

- **WHEN** user runs `rayfin init my-cool-app` (interactive mode)
- **THEN** the system uses `my-cool-app` as the project name without prompting
- **AND** the system emits `🔖 Project name: my-cool-app` to confirm the resolved name before scaffolding starts

#### Scenario: Skip prompt for whitespace-containing positional

- **WHEN** user runs `rayfin init "My Cool App"` (interactive mode)
- **THEN** the system uses `My Cool App` as the project display name without prompting
- **AND** `rayfin.yml.name` is `"My Cool App"`
- **AND** `rayfin.yml.id` is `"my-cool-app"`
- **AND** `package.json.name` is `"my-cool-app"`

#### Scenario: --project-name overrides positional for project name only

- **WHEN** user runs `rayfin init "My App" --project-name "Custom"` (interactive mode)
- **THEN** the system uses `Custom` as the project name (NOT `My App`)
- **AND** the on-disk directory is still `my-app/` (slugified from the positional, NOT from `--project-name`)
- **AND** `package.json.name` is `"custom"`

#### Scenario: In-place directory still prompts

- **WHEN** user runs `rayfin init .` (interactive mode)
- **THEN** the system prompts for the project name (defaulting to the cwd basename)

#### Scenario: Invalid basename falls back to safe prompt default

- **WHEN** user runs `rayfin init "123-invalid"` (interactive mode) where `123-invalid` does not pass `isValidProjectName`
- **THEN** the system prompts for the project name with the safe default `"My Rayfin App"`
- **AND** does NOT pass the invalid `123-invalid` string to validation

### Requirement: Whitespace slugification of on-disk directory

When the positional argument is a single bare name (no path separators `/` or `\`, not absolute, not in-place) AND contains whitespace, the system SHALL slugify the positional to kebab-case for the on-disk directory.

When the positional is path-like (`./My App`, `../My App`, `/tmp/My App`), absolute, in-place (`.`, `./`), or whitespace-free, the positional SHALL pass through to the filesystem unchanged.

The `--project-name` flag SHALL NOT affect the on-disk directory layout (directory and project identity are separate concerns).

#### Scenario: Whitespace bare-name slugifies to kebab on disk

- **WHEN** user runs `create-rayfin "My App"`
- **THEN** the on-disk directory is `my-app/`
- **AND** `rayfin.yml.name` is `"My App"` (display form preserved)

#### Scenario: Whitespace-free bare-name passes through

- **WHEN** user runs `create-rayfin MyApp` or `create-rayfin App_2`
- **THEN** the on-disk directory is `MyApp/` or `App_2/` respectively (no slugification)

#### Scenario: Path-like positional is the escape hatch

- **WHEN** user runs `create-rayfin "./My App"`
- **THEN** the on-disk directory is `My App/` (literal whitespace preserved — user's explicit opt-out)

#### Scenario: Absolute path is preserved literally

- **WHEN** user runs `create-rayfin "/tmp/my-app"` or `create-rayfin "C:\Users\me\my-app"`
- **THEN** the on-disk directory is the absolute path as typed (no slugification)

### Requirement: Resolution-based in-place detection

The system SHALL determine whether scaffolding is in-place by comparing `path.resolve(cwd, directory)` to `path.resolve(cwd)` rather than performing a literal-string check (`directory === '.' || './'`).

This SHALL recognize all of: `.`, `./`, `.\` (Windows shorthand), `.\\`, `./.`, `foo/..`, and any absolute path equal to cwd.

On Windows (`process.platform === 'win32'`) the comparison SHALL be case-insensitive (lowercase fold via `toLocaleLowerCase('en-US')`). NTFS and ReFS are case-insensitive by default — `process.cwd()` may return `C:\Work` while a user-supplied absolute path is `c:\work`. A strict equality check would treat those as different paths and route into the non-in-place wipe path, destroying the user's data on overwrite.

This is critical for cross-platform data-loss prevention: on Windows, `rayfin init -t <url> .\` resolves to cwd, and a literal-string check would treat it as a child target and could trigger `wipeTargetDirectory(cwd)` on user consent to overwrite.

**Out of scope** (documented gaps): 8.3 short-name expansion (`PROGRA~1` vs `Program Files`), junctions/symlinks, UNC server-name casing, and `subst` drive aliases are NOT covered by the lowercase fold. The realistic data-loss vector (drive-letter casing + segment casing for ASCII paths) IS covered. Full canonical-equivalence requires `realpathSync` and is deferred.

#### Scenario: Windows backslash forms are recognized as in-place

- **WHEN** user runs `rayfin init .\` or `rayfin init .\\` on Windows
- **THEN** the system treats this as in-place scaffolding
- **AND** does NOT call `wipeTargetDirectory` against the cwd, even when the user consents to `--overwrite` against a non-empty cwd

> Note: per #1120's contract, in-place targets STILL trigger the conflict-prompt for any non-empty target (the spec requires exit code 2 on declined-overwrite for ANY non-empty target, including the cwd). The `isInPlaceDirectory` invariant guarded by this requirement is specifically the wipe-gating: `wipeTargetDirectory` must NOT run when the resolved target equals cwd, regardless of overwrite consent. See "In-place wipe is gated regardless of overwrite consent" below.

#### Scenario: Windows case-different absolute path is recognized as in-place

- **WHEN** `process.cwd()` returns `C:\Work\Project` on Windows
- **AND** user runs `rayfin init c:\work\project` (lowercased path equivalent)
- **THEN** the system treats this as in-place scaffolding
- **AND** does NOT call `wipeTargetDirectory` against the cwd

#### Scenario: In-place wipe is gated regardless of overwrite consent

- **WHEN** user runs `rayfin init -t <src> --overwrite .` (or any in-place form recognized by `isInPlaceDirectory`) against a non-empty cwd
- **AND** the conflict-prompt path runs and the user (or `--overwrite`) consents to overwrite
- **THEN** the system SHALL NOT call `wipeTargetDirectory(cwd)`
- **AND** the existing files in cwd survive the scaffold (per-file collision resolution merges template files alongside)

#### Scenario: In-place cancellation on non-empty cwd

- **WHEN** user runs `rayfin init -t <src> .` (or any in-place form) against a non-empty cwd
- **AND** the user declines overwrite (interactive) OR omits `--overwrite` in non-interactive mode
- **THEN** the system SHALL exit with code 2 (`ScaffoldCancelledError`)
- **AND** any pre-existing files in cwd survive (no scaffold work occurred)

#### Scenario: Non-cwd-resolving paths are not in-place on Linux

- **WHEN** user runs `rayfin init my-app` or `rayfin init ./my-app` on Linux/macOS
- **THEN** the system treats these as a NEW directory, not in-place
- **AND** standard new-directory scaffolding applies

#### Scenario: Foo-dot-dot resolves to cwd and is treated as in-place

- **WHEN** user runs `rayfin init foo/..`
- **THEN** the system treats this as in-place scaffolding (the resolved path equals cwd)

### Requirement: Slug-shape allow list for whitespace-padded path metasegments

The whitespace-slugification step SHALL reject any slug output that does not match `PROJECT_SLUG_REGEX` (lowercase alphanumeric segments separated by single hyphens) and SHALL fall back to the literal user input in that case.

This is critical because `generateProjectSlug` preserves dots — `" . "` slugifies to `"."` and `" .. "` to `".."` — paths that `path.resolve` collapses to cwd or its parent. The `isInPlaceDirectory` check in dispatchers runs BEFORE slugification on the raw input, so a whitespace-padded `" . "` correctly resolves to a literal child directory and `isInPlaceDirectory` returns false. Without this allow list, the post-slugification `path.resolve(cwd, ".")` would still equal cwd and route the wipe path against the user's cwd.

#### Scenario: Slugifier rejects "." output

- **WHEN** user runs `rayfin init " . "` (whitespace-padded dot)
- **THEN** the on-disk directory is the literal `" . "` (a child of cwd named `" . "`)
- **AND** the wipe path is NOT triggered against cwd

#### Scenario: Slugifier rejects ".." output

- **WHEN** user runs `rayfin init " .. "` (whitespace-padded double-dot)
- **THEN** the on-disk directory is the literal `" .. "` (a child of cwd named `" .. "`)
- **AND** the wipe path is NOT triggered against the parent of cwd

### Requirement: Unified Next-steps banner across template sources

The system SHALL print a unified Next-steps banner after successful scaffolding regardless of template source (bundled, external git URL, local path):

```text
🎉 Project created successfully!

Next steps:

  cd <directoryForFS>     ← omitted when scaffolding in-place
  npx rayfin dev
  npm run dev
```

The banner SHALL be omitted in `--json` output mode and SHALL be written to stderr in plain (non-TTY) mode (consistent with `modeLog` policy).

The `cd` line SHALL be omitted when scaffolding in-place (`isInPlaceDirectory(directory)` returns true).

The `cd` argument SHALL be platform-shell-quoted via `formatCdTarget` when it contains shell-significant characters (whitespace, parens, semicolons, ampersands, `$`, `*`, `?`, etc.) — anything outside the safe shell charset `[A-Za-z0-9._\-/\\:]`.

#### Scenario: Banner appears for bundled, external, and local paths

- **WHEN** user runs any of `rayfin init` (bundled), `rayfin init -t <git-url>`, or `rayfin init -t <local-path>` and the scaffold succeeds
- **THEN** the system prints the unified Next-steps banner
- **AND** the banner content is identical across the three paths

#### Scenario: cd line omitted for in-place scaffolding

- **WHEN** user runs `rayfin init .` (or any in-place form recognized by `isInPlaceDirectory`)
- **AND** scaffolding succeeds
- **THEN** the Next-steps banner shows `npx rayfin dev` and `npm run dev` only
- **AND** does NOT include a `cd <project>` line

#### Scenario: cd line is shell-safe quoted

- **WHEN** user runs `create-rayfin "App(v2)"` and scaffolding succeeds
- **THEN** the Next-steps banner contains `cd 'App(v2)'` (single-quoted)
- **AND** the line is safe to paste into bash/zsh/PowerShell without syntax errors

#### Scenario: Banner suppressed in JSON output mode

- **WHEN** user runs `rayfin init my-app --json` (or any flag that resolves to JSON output mode)
- **THEN** the Next-steps banner is NOT emitted to stdout or stderr
- **AND** stdout contains only the JSON output payload

### Requirement: --help discloses positional dual-use semantics

The `--help` text for `[directory]` SHALL disclose that:

1. The positional value defaults to the current directory (`.`).
2. A bare name with whitespace causes the on-disk directory to be slugified (`"My App"` → `my-app/`).
3. The typed value becomes the default project name unless `--project-name` overrides it.
4. A path-like value (`./My App`) is the escape hatch for keeping the literal directory.

The `--help` text for `--project-name <name>` SHALL disclose that the flag overrides the project name only (not the directory) and that the typed display form is preserved.

#### Scenario: --help text discloses slugify rule

- **WHEN** user runs `rayfin init --help` or `create-rayfin --help`
- **THEN** the `[directory]` help text mentions whitespace slugification with a concrete example (e.g., `"My App"` → `my-app/`)
- **AND** the help text mentions the path-like escape hatch (`./My App`)
- **AND** the `--project-name` help text mentions that it overrides the project name only (not the directory)

### Requirement: Project-root .gitignore

The `rayfin init` command SHALL produce a `.gitignore` at the **project root** (not at `rayfin/.gitignore`) so `git status` is clean from the start. The system SHALL source this file from `assets/.gitignore.template`.

The asset content SHALL cover:

- Dependency directories: `node_modules`
- Build output: `dist`, `dist-ssr`, `*.tsbuildinfo`, `.vite`
- Test coverage: `coverage`
- Local env files: `*.local` (matches `.env.local`, `.env.*.local`, and any other `*.local` patterns)
- Rayfin-generated or secret-bearing paths (relative to project root): `rayfin/.env*` (covers `.env`, the `.env.bak` written by the env-file v2 migration, and future `.env`-family files), `rayfin/.deployments.json`, `rayfin/.temp/`
- Standard log noise: `*.log`, `npm-debug.log*`, `yarn-debug.log*`, `yarn-error.log*`, `pnpm-debug.log*`, `lerna-debug.log*`
- OS / editor noise: `.DS_Store`, `.idea`, `*.suo`, `*.ntvs*`, `*.njsproj`, `*.sln`, `*.sw?`

The asset's filename SHALL retain the `.template` suffix so `npm pack` ships it in the published tarball (npm strips files literally named `.gitignore` from package contents, including nested ones — so a sample-level `.gitignore` would not survive publishing).

The write semantics interact with the "Force Overwrite Option" requirement:

- When `--from-template` is passed (create-rayfin synchronization mode) and the file exists, the system MERGES the asset content into the existing `.gitignore`: only canonical patterns missing from the existing file are appended under a labeled `# Added by Rayfin CLI` section. Template-author and user lines are preserved verbatim. The merge is idempotent — re-running on a fully covered file leaves the bytes unchanged.
- When `--from-template` is not passed and the file is missing, the asset is written.
- When `--from-template` is not passed and the file exists, the system prompts the user (interactive) or honors `--overwrite` (non-interactive). On consent, the file is replaced with the canonical asset content (this path is the user's explicit choice, not a sync).

#### Scenario: Bundled template scaffold writes root .gitignore

- **WHEN** a user runs `rayfin init --template <bundled-name> <target>` (or `npm create @microsoft/rayfin <target> -- --template <bundled-name>`)
- **THEN** `<target>/.gitignore` exists at the project root
- **AND** its content covers `node_modules`, `dist`, `rayfin/.env*`, `rayfin/.deployments.json`, `rayfin/.temp/`
- **AND** `git status` in the scaffolded project shows no `node_modules/`, `dist/`, `.env.local`, `*.tsbuildinfo`, or `rayfin/.env*` entries as untracked

#### Scenario: External template that ships its own root .gitignore is merged

`rayfin init -t <git-url>` enters the post-scaffold pipeline, which spawns `rayfin init --from-template` internally — so the synchronization-mode contract from "Force Overwrite Option" applies even though the user did not pass `--from-template` directly on their command line.

The contract for this requirement is **canonical Rayfin patterns must be present in the project-root `.gitignore`** so `git status` is clean from the start. It is NOT "the project-root `.gitignore` must be byte-for-byte the canonical asset." Either mechanism — write the canonical asset when no file exists, or merge the missing canonical patterns into an existing template-author file — satisfies the contract. The previous implementation reached the contract by overwriting; the current implementation reaches it by merging, so external template authors can ship a curated `.gitignore` without it being silently destroyed.

- **WHEN** a user runs `rayfin init -t <git-url> <target>` against an external template that already ships `<target>/.gitignore` with template-author-curated content
- **THEN** every line the template author authored survives in the resulting `.gitignore`
- **AND** any canonical Rayfin patterns that were missing from the template's `.gitignore` are appended under a `# Added by Rayfin CLI` header (so the addition is diff-visible)
- **AND** the operation is idempotent — re-running the same scaffold against a fully covered file does not mutate the bytes

#### Scenario: External template without a root .gitignore gets the default

- **WHEN** a user runs `rayfin init -t <git-url> <target>` against an external template that does not ship a root `.gitignore`
- **THEN** `<target>/.gitignore` is created from the asset
- **AND** its content covers the standard set listed above

#### Scenario: Re-run via --from-template merges new canonical content

- **WHEN** `create-rayfin` (or another caller) re-runs `rayfin init --from-template` against a project that already has a `.gitignore`
- **THEN** any canonical Rayfin patterns missing from the existing file are appended under a `# Added by Rayfin CLI` header
- **AND** every line the template author or user previously authored is preserved
- **AND** no prompt is shown
- **AND** the merge is idempotent — re-running once everything is in place leaves the file unchanged
