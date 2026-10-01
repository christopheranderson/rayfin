## ADDED Requirements

### Requirement: Command Group Structure

The CLI SHALL expose a `rayfin docs` command group with package-scoped subcommands (`list`, `search`, `get`, `discover`, and `catalog show`) that wrap the shared docs package and package discovery catalog.

#### Scenario: List subcommand
- **WHEN** a user runs `rayfin docs list`
- **THEN** the CLI prints every doc entry from every module in human-readable form
- **AND** when `--module <guide|host|ts-sdk>` is provided, the CLI filters to that module
- **AND** when `--json` is provided, the CLI emits `{ status, schemaVersion, module, count, items }`

#### Scenario: Search subcommand
- **WHEN** a user runs `rayfin docs search "<query>"`
- **THEN** the CLI runs a minisearch query through `DocsService` and prints results with snippets
- **AND** when `--module`, `--scope <docs|symbols|all>`, or `--limit <N>` are provided the CLI passes them through to `DocsService`
- **AND** the CLI rejects `--limit` values outside `[1, 50]` with a fix-it message
- **AND** when `--json` is provided, the CLI emits `{ status, schemaVersion, query, module, scope, limit, count, results }`

#### Scenario: Get subcommand
- **WHEN** a user runs `rayfin docs get --id <id>` or `--path <path>` or `--symbol <name>`
- **THEN** exactly one of the three lookup flags is required
- **AND** for `--id` / `--path` lookups the CLI emits a single entry
- **AND** for `--symbol` lookups the CLI emits the matching sections, optionally filtered by `--module` and capped by `--limit`
- **AND** when `--json` is provided, the CLI emits a `schemaVersion: 1` envelope appropriate to the lookup form

#### Scenario: Discover subcommand
- **WHEN** a user runs `rayfin docs discover "<query>"`
- **THEN** the CLI searches the bundled Rayfin package catalog and prints matching install/update recommendations
- **AND** when `--json` is provided, the CLI emits `{ status, schemaVersion, query, count, total, items }`

#### Scenario: Catalog subcommand
- **WHEN** a user runs `rayfin docs catalog show`
- **THEN** the CLI prints the package discovery catalog summary
- **AND** when `--json` is provided, the CLI emits `{ status, schemaVersion, catalog, count }`

### Requirement: JSON Envelope Stability

The CLI SHALL stamp every `--json` response with `schemaVersion: 1` and a `status` field (`ok` or `error`) so JSON consumers can fail closed on shape skew.

#### Scenario: Successful response
- **WHEN** any `--json` invocation succeeds
- **THEN** the response begins with `{ "status": "ok", "schemaVersion": 1, ... }`
- **AND** the process exit code is 0

#### Scenario: Error response
- **WHEN** any `--json` invocation fails (unknown id, missing flags, invalid scope, etc.)
- **THEN** the response is `{ "status": "error", "schemaVersion": 1, "error": "<message>" }`
- **AND** the process exit code is non-zero

#### Scenario: Schema version bumps
- **WHEN** a future change alters the shape inside the envelope in a non-additive way
- **THEN** `schemaVersion` is incremented to `2` (or higher) and the change is documented in a follow-up `rayfin-docs-cli` change folder

### Requirement: Content Parity with the MCP Server

The `rayfin docs` CLI and the `@microsoft/rayfin-mcp` server SHALL return the same content for equivalent queries when both are built from the same workspace state, because both transports route through a single `DocsService` instance.

#### Scenario: List parity
- **WHEN** the CLI runs `rayfin docs list --module ts-sdk --json` and the MCP server runs `list_docs(module="ts-sdk")` against the same workspace build
- **THEN** the inner `items` array of the CLI envelope deep-equals the parsed array from the MCP tool result content

#### Scenario: Search parity
- **WHEN** the CLI runs `rayfin docs search "<q>" --scope <s> --limit <n>` and the MCP server runs `search_docs(query="<q>", scope="<s>", limit=<n>)`
- **THEN** the inner `results` array deep-equals the MCP tool result array, in the same order

#### Scenario: Get parity
- **WHEN** the CLI runs `rayfin docs get --id <id> --json` and the MCP server runs `get_doc(id="<id>")`
- **THEN** the CLI's inner `entry` object deep-equals the MCP tool result object

### Requirement: Installed Package Version-Locking

The docs corpus that `rayfin docs` reads SHALL be version-locked to the Rayfin packages installed in the caller's project so results reflect the APIs available to that project.

#### Scenario: Project-local package docs
- **WHEN** a user runs `rayfin docs` from a Rayfin project
- **THEN** the CLI discovers docs from known Rayfin packages in that project's `node_modules`
- **AND** a locally installed CLI and a globally installed CLI resolve the same project package docs when invoked from the same project directory
- **AND** packages outside the known Rayfin catalog are not walked by default

#### Scenario: Package update invalidates the cache
- **WHEN** a user installs or updates a Rayfin package that ships docs
- **THEN** the next CLI or MCP docs request detects the changed package fingerprint
- **AND** the docs index is rebuilt from the newly installed package docs

### Requirement: Eval Harness for Transport Drift Detection

The repository SHALL ship a manual, reproducible eval harness under `packages/tools/cli/eval/docs-transports/` that compares the CLI and the MCP server transports for content equivalence and characterizes the latency difference.

#### Scenario: Equivalence is the primary signal
- **WHEN** a contributor runs the eval harness against a built workspace
- **THEN** the harness reports a passes/failures count for content equivalence at the top of `RESULTS.md`
- **AND** content equivalence failures are treated as bugs in either the CLI or the MCP layer, not as expected behavior

#### Scenario: Reproducibility metadata
- **WHEN** the eval harness writes `RESULTS.md`
- **THEN** the file includes git SHA, Node version, OS, the resolved `@microsoft/rayfin-cli` and `@microsoft/rayfin-mcp` versions, the docs corpus byte/file count, and the run parameters (`RUNS_PER_QUERY`, `WARMUP_RUNS`)

#### Scenario: Telemetry opt-out for fair latency
- **WHEN** the eval harness spawns either transport
- **THEN** the spawn environment includes `RAYFIN_TELEMETRY_OPTOUT=1` so telemetry initialization does not contaminate transport latency numbers
