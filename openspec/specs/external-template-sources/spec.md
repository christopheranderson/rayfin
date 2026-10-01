# external-template-sources Specification

## Purpose

External template sources enable Rayfin projects to be scaffolded from git-hosted template repositories.
The system supports catalogs, parameterized prompts, agent-friendly discovery, and curated template collections.
All template functionality lives in `rayfin init`.
The `create-rayfin` CLI forwards to `rayfin init`.

## Requirements

### Requirement: Template Source Resolution

The `rayfin init` command SHALL accept a `-t`/`--template` flag whose value can be a built-in template name, a git URL, or a local filesystem path.
The system resolves the value in the following order:

1. If the value matches a known built-in template name, use that template directly.
2. If the value is a git URL (HTTPS, SSH, `git@`, or `.git` suffix), clone the repository.
3. If the value is a local filesystem path, use it directly.
4. Otherwise, reject as invalid.

Supported URL schemes are HTTPS, SSH, and `git@` URLs.
The system clones the repository using a shallow clone.
Templates are discovered via `rayfin-template.yml` manifest files within the cloned repository.
Files are copied verbatim, with filename placeholder substitution (`__paramName__` → value).

> **Deferred:** Handlebars rendering of file contents (with case helpers and conditional blocks) is part of the parameterization follow-up.

Note: `github:` shorthand and `org/repo` shorthand are deferred to a future iteration.

#### Scenario: Clone HTTPS template repository

- **WHEN** user runs `rayfin init -t https://github.com/org/templates.git`
- **THEN** the system performs a shallow clone of the repository
- **AND** discovers templates via `rayfin-template.yml` manifests
- **AND** copies template files to the target directory

#### Scenario: Clone SSH template repository

- **WHEN** user runs `rayfin init -t git@github.com:org/templates.git`
- **THEN** the system performs a shallow clone of the repository
- **AND** discovers templates via `rayfin-template.yml` manifests

#### Scenario: Render Handlebars template with case helpers (deferred)

> **Deferred to parameterization follow-up.**

- **WHEN** a template file contains Handlebars expressions with case helpers
- **THEN** the system renders the file with the appropriate case transformations
- **AND** evaluates conditional blocks based on provided parameters

#### Scenario: Reject unsupported shorthand

- **WHEN** user runs `rayfin init -t org/repo`
- **THEN** the system rejects the input as an unsupported shorthand format
- **AND** displays an error message indicating the format is not yet supported

#### Scenario: Non-interactive scaffolding from single-template source

- **WHEN** an agent runs `rayfin init -t https://github.com/org/template.git --project-name my-app --yes .`
- **THEN** the system clones, discovers the single template, scaffolds without prompts
- **AND** exits with code 0 on success

#### Scenario: Report errors as structured output for agents

- **WHEN** an agent runs `rayfin init -t <invalid-url> --yes .`
- **THEN** the system exits with a non-zero code
- **AND** writes the error message to stderr

### Requirement: Local Path Template Source

The `rayfin init` command SHALL accept a `-t` flag with a local filesystem path pointing to a template directory.

#### Scenario: Use local directory as template source

- **WHEN** user runs `rayfin init -t ./my-templates`
- **AND** the path exists and is a directory
- **THEN** the system uses the local directory as the template source
- **AND** discovers templates via `rayfin-template.yml` manifests

#### Scenario: Reject non-existent local path

- **WHEN** user runs `rayfin init -t ./does-not-exist`
- **AND** the path does not exist
- **THEN** the system reports an error indicating the path does not exist

#### Scenario: Reject non-directory local path

- **WHEN** user runs `rayfin init -t ./some-file.txt`
- **AND** the path exists but is not a directory
- **THEN** the system reports an error indicating the path is not a directory

### Requirement: Template Catalogs

Template manifests use an `entries` array to list available templates.
Entries can be organized into groups for interactive navigation through template categories.

#### Scenario: Navigate multi-entry manifest interactively

- **WHEN** user runs `rayfin init -t <url>` and the manifest has multiple entries
- **THEN** the system presents an interactive picker showing available templates
- **AND** user can navigate through nested groups to select a template

#### Scenario: Select template by name non-interactively

- **WHEN** user runs `rayfin init -t <url> --template-name my-template`
- **AND** the manifest has multiple entries
- **THEN** the system selects the template matching `my-template` without interactive prompts

#### Scenario: Auto-select single-entry manifest

- **WHEN** user runs `rayfin init -t <url>` in non-interactive mode
- **AND** the manifest contains exactly one template entry
- **THEN** the system automatically selects that single template

#### Scenario: Non-interactive with multiple entries requires --template-name

- **WHEN** an agent runs `rayfin init -t <catalog-url> --yes .` without `--template-name`
- **AND** the manifest contains multiple templates
- **THEN** the system exits with a non-zero code
- **AND** the error message lists all available template names for the agent to retry with `--template-name`

### Requirement: Manifest Versioning

Template manifests SHALL use `apiVersion: v1` to declare the manifest format version.

#### Scenario: CLI validates apiVersion

- **WHEN** the CLI parses a `rayfin-template.yml` manifest
- **AND** the `apiVersion` field is present
- **THEN** the CLI validates it against supported versions
- **WHEN** the `apiVersion` is not supported
- **THEN** the CLI exits with a clear error suggesting an upgrade

Note: `apiVersion` tracks the manifest schema version, not the template content version.
Template content versioning (SDK dependencies, etc.) is handled by the project's `package.json` after scaffolding.

### Requirement: Template Registry and Discovery

The system SHALL support a `template-registries.yml` file for registering external template sources.
Template discovery SHALL prefer manifest-first lookup with a fallback to `package.json`.

#### Registry entry format

Each registry entry supports the following fields:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier for this registry entry |
| `displayName` | No | Human-readable name (defaults to `name`) |
| `description` | No | Short description of the template source |
| `url` | Yes | Git URL of the template repository |
| `ref` | No | Stable/default Git ref (released tag or 40-character commit SHA) to pin to a specific version |
| `alphaRef` | No | Git ref selected for alpha CLI versions; falls back to `ref` |
| `betaRef` | No | Git ref selected for beta CLI versions; falls back to `ref` |
| `path` | No | Subdirectory within the repo to scope to (e.g., a specific catalog) |
| `templateName` | No | Manifest entry name to select from a multi-template registry source |
| `default` | No | Whether this is a CLI-shipped default entry (read-only) |
| `firstClass` | No | Whether a CLI-shipped entry should appear as a bundled template and route before the bundled fallback |

#### Scenario: Pin registry entry to a specific version

- **WHEN** a registry entry includes `ref: v1.2.0`
- **THEN** the system clones the repository at that specific git tag
- **AND** the template content matches the pinned state

Note: the `ref` field provides version pinning for remote templates.
The CLI team pins default registry entries to tested tags or 40-character commit SHAs with each CLI release.
Branch refs such as `main`, `master`, or `HEAD` are prohibited for CLI-shipped entries because CLI releases ship a frozen view of the template.

#### Scenario: Select a registry ref from the CLI release channel

- **WHEN** a registry entry includes `ref`, `alphaRef`, and `betaRef`
- **AND** the running CLI version has an `alpha` prerelease identifier
- **THEN** the system clones the repository at `alphaRef`
- **WHEN** the running CLI version has a `beta` prerelease identifier
- **THEN** the system clones the repository at `betaRef`
- **WHEN** the running CLI version is stable or uses another prerelease identifier
- **THEN** the system clones the repository at `ref`
- **AND** a missing `alphaRef` or `betaRef` falls back to `ref`

#### Scenario: Select a specific manifest entry from a multi-template source

- **WHEN** a registry entry includes `templateName: Data App`
- **AND** the referenced source contains multiple manifest entries
- **THEN** the CLI scaffolds the manifest entry named `Data App`
- **AND** the registry entry's `name` remains the CLI-facing alias

#### Scenario: Scope registry entry to a catalog path

- **WHEN** a registry entry includes `path: catalogs/official`
- **THEN** the system looks for `rayfin-template.yml` at that path within the repo
- **AND** only templates within that catalog are surfaced to users

#### Scenario: Template name conflicts

- **WHEN** a bundled template and a registry template have the same name
- **THEN** the bundled template takes precedence
- **EXCEPT WHEN** the registry entry is a CLI-shipped `firstClass` entry
- **THEN** the registry entry routes first and may fall back to the bundled template with the same name on supported failures
- **WHEN** two registry entries define templates with the same name
- **THEN** the system reports an error listing the conflicting sources
- **AND** the user can disambiguate with `<registry-name>/<template-name>`

#### Scenario: First-class registry entry falls back to bundled template

- **WHEN** a CLI-shipped `firstClass` registry entry routes before a bundled template with the same name
- **AND** the registry path fails with a handled `CliHandledError`
- **AND** a bundled template with the same name exists
- **THEN** the CLI writes a warning that it is falling back to the bundled template
- **AND** the warning states that the bundled fallback may differ from the pinned external template
- **AND** the CLI scaffolds the bundled template with the same name
- **WHEN** the registry path is cancelled with `ScaffoldCancelledError`
- **THEN** the CLI propagates cancellation
- **AND** it does not scaffold the bundled fallback
- **WHEN** the registry path fails with an unexpected error
- **THEN** the CLI propagates the error
- **AND** it does not scaffold the bundled fallback

#### Scenario: First-class alias is not overridable by template name

- **WHEN** a user selects a CLI-shipped `firstClass` registry alias
- **AND** the registry entry defines `templateName`
- **THEN** the registry entry's `templateName` selects the manifest entry
- **WHEN** the user also provides a conflicting `--template-name` value
- **THEN** the CLI exits with a clear error
- **AND** it does not scaffold a different manifest entry

#### Scenario: CLI ships with default sanctioned registries

- **WHEN** the CLI is installed
- **THEN** it includes a default `template-registries.yml` with Microsoft-maintained template sources
- **AND** entries in the default registry are marked with `default: true`
- **AND** the default registry is maintained in source control and changes require PR review

#### Scenario: Project-local registries extend defaults

- **WHEN** a project has `.rayfin/template-registries.yml`
- **THEN** the system merges project-local entries with the CLI default entries
- **AND** project-local entries cannot remove or override default or first-class entries
- **AND** the `default` and `firstClass` flags are ignored in project-local registry files
- **AND** the `templateName` field remains available for project-local entries to scope multi-template sources

#### Scenario: Load registered template sources

- **WHEN** user runs `rayfin init`
- **AND** a `template-registries.yml` file exists
- **THEN** the system loads all registered sources from the file
- **AND** presents them alongside bundled templates

#### Scenario: List all available templates

- **WHEN** user runs `rayfin init --list-templates`
- **THEN** the system outputs JSON containing all available templates
- **AND** the output includes both bundled and registry-sourced templates
- **AND** first-class registry templates are listed with bundled templates as built-in entries

#### Scenario: Agent discovers templates then scaffolds

- **WHEN** an agent runs `rayfin init --list-templates` to discover available templates
- **THEN** the JSON output includes template names, display names, and descriptions
- **AND** the agent can use a template name in a subsequent `rayfin init --template <name> --yes .` call

#### Scenario: Registry picker in interactive mode

- **WHEN** user runs `rayfin init` interactively
- **AND** registered template sources are available
- **THEN** the system shows a picker that includes both bundled templates and registry entries

#### Scenario: Manifest-first template discovery

- **WHEN** the system discovers templates in a repository
- **THEN** it first looks for `rayfin-template.yml` manifests
- **AND** falls back to `package.json` only if no manifest is found

### Requirement: Parameterized Templates

> **Deferred:** This requirement is deferred to the parameterization follow-up changeset. V1 ships filename placeholder substitution only (`__paramName__` → value); content rendering, parameter prompts, and validation are tracked here for future implementation.

Templates SHALL support parameters with types `string`, `boolean`, `choice`, and `multi-choice`.
Parameters enable dynamic scaffolding based on user input or configuration.

#### Scenario: Prompt for string parameter

- **WHEN** a template defines a parameter of type `string`
- **AND** user runs `rayfin init` interactively
- **THEN** the system prompts the user for a string value

#### Scenario: Prompt for boolean parameter

- **WHEN** a template defines a parameter of type `boolean`
- **AND** user runs `rayfin init` interactively
- **THEN** the system prompts the user with a yes/no confirmation

#### Scenario: Prompt for choice parameter

- **WHEN** a template defines a parameter of type `choice` with a list of options
- **AND** user runs `rayfin init` interactively
- **THEN** the system presents the options as a single-select picker

#### Scenario: Prompt for multi-choice parameter

- **WHEN** a template defines a parameter of type `multi-choice` with a list of options
- **AND** user runs `rayfin init` interactively
- **THEN** the system presents the options as a multi-select picker

#### Scenario: Conditional file inclusion

- **WHEN** a template defines a `when` expression on a file entry
- **THEN** the system includes the file only if the `when` expression evaluates to true based on provided parameters

#### Scenario: Validate parameter with pattern

- **WHEN** a template defines a validation `pattern` on a string parameter
- **THEN** the system validates user input against the pattern
- **AND** rejects patterns longer than 200 characters to prevent ReDoS attacks

#### Scenario: Describe template parameters

- **WHEN** user runs `rayfin init -t <url> --describe`
- **THEN** the system outputs JSON describing all template parameters
- **AND** includes type, default value, and validation rules for each parameter

#### Scenario: Provide parameters via config file

- **WHEN** user runs `rayfin init -t <url> --config params.json`
- **THEN** the system reads parameters from the JSON file
- **AND** rejects config files larger than 1MB via a pre-read size check using `statSync`

#### Scenario: Provide parameters via inline JSON config

- **WHEN** user runs `rayfin init -t <url> --config '{"key":"value"}'`
- **THEN** the system parses the inline JSON as parameter values

#### Scenario: Provide parameters via command line

- **WHEN** user runs `rayfin init -t <url> --param key=value`
- **THEN** the system applies the parameter with appropriate type coercion

#### Scenario: Parameter priority order

- **WHEN** user provides parameters via `--config`, named flags, and `--param`
- **THEN** the system applies parameters in priority order: `--config` (lowest) then named flags then `--param` (highest)

#### Scenario: Non-interactive mode uses defaults

- **WHEN** user runs `rayfin init` in non-interactive mode
- **AND** a template parameter has a default value
- **THEN** the system uses the default value without prompting

#### Scenario: Non-interactive mode fails on missing required

- **WHEN** user runs `rayfin init` in non-interactive mode
- **AND** a required template parameter has no default value and no value provided
- **THEN** the system reports an error listing the missing required parameters

### Requirement: Template Caching

> **Deferred:** Caching is deferred to a follow-up changeset. V1 fetches a fresh shallow clone on every invocation. The behavior below is tracked here for future implementation.

The system SHALL cache cloned template repositories persistently at `~/.rayfin/template-cache/`.
Cache entries have a time-to-live (TTL) based on the ref type.

#### Scenario: Cache branch ref with TTL

- **WHEN** the system clones a template repository for a branch ref
- **THEN** the system stores the clone in `~/.rayfin/template-cache/`
- **AND** sets a 1-hour TTL on the cache entry

#### Scenario: Cache semver tag permanently

- **WHEN** the system clones a template repository for a semver tag
- **AND** the tag matches an anchored semver regex
- **THEN** the system stores the clone with no expiration

#### Scenario: Atomic cache writes

- **WHEN** the system writes to the template cache
- **THEN** it writes to a temporary location first and renames atomically
- **AND** falls back to copy-and-delete on `EXDEV` errors (cross-device)

#### Scenario: Bypass cache with flag

- **WHEN** user runs `rayfin init -t <url> --no-cache`
- **THEN** the system performs a fresh clone without reading from cache
- **AND** does not update the cache with the new clone

#### Scenario: Validate cache metadata on load

- **WHEN** the system reads a cache entry
- **THEN** it validates the JSON metadata file before using the cached data
- **AND** treats invalid metadata as a cache miss

### Requirement: Security

The template system SHALL enforce security protections against path traversal, symlink attacks, prototype pollution, git injection, and oversized inputs.

#### Scenario: Prevent path traversal

- **WHEN** a template file path resolves outside the target directory
- **THEN** the system rejects the file using `resolve` + `startsWith` + `sep` validation
- **AND** does not write the file to disk

#### Scenario: Reject symlinks in source

- **WHEN** a template source directory contains symlinks
- **THEN** the system skips symlinked files during template processing

#### Scenario: Reject symlinks in target

- **WHEN** a rendered file target path is a symlink
- **THEN** the system verifies via `lstat` and rejects the write operation

#### Scenario: Prevent prototype pollution

- **WHEN** the system parses user-provided JSON (config files, parameters)
- **THEN** it creates objects with null prototype
- **AND** rejects keys in the `FORBIDDEN_KEYS` set (e.g., `__proto__`, `constructor`, `prototype`)
- **AND** uses a JSON reviver to filter dangerous keys

#### Scenario: Prevent git injection

- **WHEN** a template URL or ref contains a dash-prefixed argument
- **THEN** the system rejects the input to prevent git command injection
- **AND** uses `--` separator in all git command invocations
- **AND** executes git via `execFileSync` (not shell interpolation)

#### Scenario: Validate database dialect

- **WHEN** a template specifies a database dialect
- **THEN** the system validates it against the known dialect allowlist
- **AND** rejects unknown dialect values

#### Scenario: Pre-check config file size

- **WHEN** user provides a `--config` file path
- **THEN** the system checks the file size via `statSync` before reading
- **AND** rejects files larger than 1MB

### Requirement: Template Bundling

The build system SHALL support bundling curated template collections into the CLI distribution.
Template sources are defined in a `template-sources.yml` allowlist.

#### Scenario: Bundle from local source

- **WHEN** the build runs and `template-sources.yml` lists a local directory
- **THEN** the system copies the template files into the CLI distribution

#### Scenario: Bundle from remote source

- **WHEN** the build runs and `template-sources.yml` lists a remote git URL
- **THEN** the system clones the repository and copies template files into the CLI distribution

#### Scenario: Cherry-pick templates from source

- **WHEN** `template-sources.yml` specifies a subset of templates from a source
- **THEN** the system includes only the specified templates in the bundle

#### Scenario: Detect template name collisions

- **WHEN** the build encounters two templates with the same metadata name or directory name
- **THEN** the system reports a collision error and fails the build

#### Scenario: Transform workspace dependencies

- **WHEN** a bundled template contains `workspace:*` dependency references
- **THEN** the build system transforms them to the appropriate published version numbers
