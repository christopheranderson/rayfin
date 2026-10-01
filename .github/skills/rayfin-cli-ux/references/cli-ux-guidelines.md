# Rayfin CLI UX Guidelines — Full Reference

Comprehensive standards for CLI output quality, command design, and user experience
in the Rayfin CLI (`@microsoft/rayfin-cli`).

## 1. Output Mode System

The Rayfin CLI uses a three-mode output system that automatically adapts to the execution
environment.

### 1.1 Mode Definitions

Channels below reflect the current behavior of the helpers in
[`packages/tools/cli/src/utils/output-mode.ts`](../../../packages/tools/cli/src/utils/output-mode.ts).

| Mode | Triggered by | `modeLog` channel | `modeError` / `modeWarn` channel | Final structured result |
|------|-------------|-------------------|----------------------------------|-------------------------|
| `interactive` | TTY stdout | `stdout` (formatted text); ora spinners write to `stderr` | `stderr` | `stdout` (formatted text) |
| `plain` | Non-TTY stdout | `stderr` (plain text) | `stderr` | `stderr` only; `stdout` stays empty |
| `json` | `--json` flag | suppressed | suppressed | `stdout` (single JSON object via `emitJson` / `emitJsonError`) |

### 1.2 Mode Resolution

Resolve mode once at the entry point of every action handler using `resolveOutputMode()`.
Never resolve it multiple times or pass raw boolean flags instead of the resolved mode.

```typescript
// At the top of every .action() handler
const mode = resolveOutputMode({ json: cmdOptions.json });
```

Priority: `--json` > TTY detection.
When `--json` is set, `json` mode is always used regardless of TTY status.

### 1.3 Output Routing Rules

- **Interactive mode** — `modeLog` writes to `stdout`; `modeError`, `modeWarn`, and ora spinners write to `stderr`.
- **Plain mode** — `modeLog`, `modeError`, and `modeWarn` all write to `stderr`. `stdout` stays empty so the output is pipe-safe.
- **JSON mode** — `modeLog`, `modeError`, and `modeWarn` are suppressed. Only `emitJson` and `emitJsonError` write to `stdout`, and they MUST emit exactly one JSON object.
- **Ora spinners** — only created in `interactive` mode; ora writes to `stderr` via its own library.
- **Verbose debug** — `createVerboseLogger` is currently not mode-aware and writes to `stdout` via `console.log`. Do not enable verbose output in `json` mode — it would corrupt the JSON object on `stdout`.
- **`--verbose` + `--json` rejection** — The CLI MUST reject the combination of `--verbose` and `--json` with an error and exit code `1` before any work is performed. The two flags are mutually exclusive because verbose text would corrupt the single-JSON-object contract on `stdout`.

## 2. Progress and Status Messages

### 2.1 Interactive Mode: Ora Spinners

In interactive mode, use ora spinners for every discrete step.
Create a `ProgressIndicator` by wrapping the ora spinner with `wrapOraSpinner()`.

```typescript
const spinner = ora({ text: `${emoji} ${message}...`, color: 'blue' }).start();
const progress = wrapOraSpinner(spinner, message);
// On success:
progress.succeed('Step completed');
// On failure:
progress.fail('Step failed');
```

Spinner colour SHOULD be `blue`.
The spinner prefix SHOULD include a contextually relevant emoji followed by a space and the
step description.

### 2.2 Plain Mode: Structured Stderr Lines

In plain (non-TTY) mode, emit structured lines to `stderr`:

```text
[rayfin <command>] <Step description>... done
[rayfin <command>] <Step description>... FAILED
```

The prefix `[rayfin <command>]` MUST match the command name (e.g., `[rayfin up]`).
Step descriptions SHOULD use action-oriented wording (for example, `Creating workspace...`).

### 2.3 JSON Mode: Silent Progress

In `json` mode, no progress output is emitted.
The `ProgressIndicator` returned by `createProgress('json', ...)` is a silent no-op that
only tracks timing for inclusion in the final JSON result.

### 2.4 Emoji Vocabulary

Use these emoji consistently across all commands.
Emoji MUST only appear in `interactive` mode.

| Emoji | Meaning | Example |
|-------|---------|---------|
| `🚀` | Operation start / deploy initiated | `🚀 Deploying project "my-app" to Fabric...` |
| `🔄` | Step in progress (spinner prefix) | `🔄 Applying database configuration...` |
| `✔` | Step succeeded (spinner succeed) | `✔ Database configuration applied (1.2s)` |
| `✖` | Step failed (spinner fail) | `✖ Database configuration failed (1.2s)` |
| `❌` | Error header (non-spinner) | `❌ Project name not found in rayfin.yml` |
| `⚠️` | Warning | `⚠️ Could not load template registry: ...` |
| `♻️` | Reusing an existing resource | `♻️ Redeployment detected — reusing item abc123` |
| `🏢` | Workspace / environment resolved | `🏢 Using workspace "My Workspace" (ID: ...)` |
| `📋` | Configuration loaded | `📋 Using project name 'my-app' from rayfin.yml` |
| `🔍` | Dry-run / preview mode active | `🔍 DRY RUN MODE - No resources will be created or modified` |
| `✅` | Overall operation complete | `✅ Deployment complete` |

### 2.5 Step Status Clarity

Every discrete operation shown to the user MUST use a `ProgressIndicator`.
Progress text MUST describe the current action (for example, `Creating workspace...`).
Timing MAY be shown in completion messages, but it is not required for every step.

## 3. Error Messages

### 3.1 Error Message Format

Every error message displayed to the user MUST follow this three-part pattern:

1. **Error header** (required): `❌ <concise description of what went wrong>`
2. **Context lines** (optional): `   <additional context if the cause is non-obvious>`
3. **Recovery hint** (required): `   <actionable next step the user can take>`

The context and recovery lines MUST be indented with three spaces to visually group them
under the header.

```text
❌ Could not find "My workspace"
   Use --workspace-id <id> to specify a workspace explicitly
```

```text
❌ Project name not found in rayfin.yml configuration
   Please ensure you have a rayfin.yml file with a project 'id' field
   Run 'rayfin init' to create a new project configuration
```

### 3.2 Error Output Channels

Error messages go to `stderr` via `modeError(mode, ...)` in `interactive` and `plain` modes.
In `json` mode, `modeError` is suppressed; surface errors via `emitJsonError(mode, message)`,
which writes `{ "status": "error", "error": "<message>" }` to `stdout` as the single JSON
result and throws `CliHandledError`.

### 3.3 CliHandledError and ScaffoldCancelledError

After printing an error, throw `CliHandledError` to prevent double-printing at the CLI
entry point:

```typescript
modeError(mode, '❌ Something failed');
modeError(mode, '   Recovery hint here');
throw new CliHandledError(new Error('Something failed'));
```

For user cancellations (user declined a prompt), throw `ScaffoldCancelledError()`.
This signals exit code `2` (distinct from `1` for errors) and records a "Cancelled"
telemetry event rather than a failure.

### 3.4 Error Message Tone

- State what went wrong in present tense: "Project name not found", not "Could not find the project name".
- Avoid jargon in user-facing errors; use technical detail only in `--verbose` output.
- Never include internal stack traces, file paths with PII, or auth tokens in error text.

## 4. JSON Output

### 4.1 Success Schema

```json
{
  "status": "success",
  "<result-field>": "<value>",
  "steps": {
    "<step-name>": {
      "duration": "1.2s",
      "status": "success"
    }
  }
}
```

The `steps` map is optional but SHOULD be included for multi-step commands so that
automation consumers can identify slow or failing steps.

### 4.2 Error Schema

```json
{
  "status": "error",
  "error": "<human-readable message>",
  "step": "<name of step that failed>"
}
```

The `step` field is optional but SHOULD be included for multi-step commands.

### 4.3 JSON Purity Rules

- `stdout` MUST contain exactly one JSON object.
- No ANSI escape sequences, spinner characters, emoji, or plain-text progress MAY appear
  in `stdout` when `--json` is active.
- Use `emitJson(data)` to write the final result — never `console.log(JSON.stringify(...))`.
- In `json` mode, `modeLog`, `modeError`, and `modeWarn` are suppressed entirely; do not
  rely on them to surface progress or errors. Surface errors via `emitJsonError(mode, message)`.
- Do not use `createVerboseLogger` in `json` mode — it writes to `stdout` via `console.log`
  and would corrupt the JSON result.

### 4.4 Reject `--verbose` with `--json`

The CLI MUST outright reject the combination of `--verbose` and `--json` and fail before any work is performed. `--verbose` writes free-form text that would corrupt the single-object contract of `--json`.

Validate the combination at the top of the action handler, before resolving the output mode or making any API calls. Emit the error on `stderr` (plain text — JSON mode is not yet active) and exit with code `1`:

```text
❌ --verbose cannot be combined with --json
   --json output requires a single JSON object on stdout; verbose logging would corrupt it.
   Re-run with either --json or --verbose, not both.
```

This is a hard validation error, not a warning. Do not silently drop `--verbose` when `--json` is set.

## 5. Flag Conventions

### 5.1 Standard Flags

Every top-level command SHOULD support these standard flags:

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| `--json` | | boolean | Output result as JSON to stdout |
| `--yes` | `-y` | boolean | Auto-accept all confirmation prompts |
| `--verbose` | | boolean | Enable verbose debug output |
| `--dry-run` | | boolean | Preview operations without executing them |
| `--force` | | boolean | Allow destructive or irreversible operations |
| `--env-file <path>` | | string | Path to `.env` file for variable interpolation |

Add `--dry-run` and `--force` only when the command has side effects.

### 5.2 Flag Description Quality

Every option description MUST:

- Start with a capital letter and use no trailing period.
- Begin with an imperative verb or noun phrase that names the effect, not just the flag: "Enable...", "Path to...", "ID of...".
- State what the flag does, not just what it is.
- Document non-obvious defaults inline: `(defaults to "My Workspace" when omitted)`.
- Include a concrete example for complex or free-form values: `(e.g. skill:rayfin)`.
- Use parentheses for defaults, constraints, and examples.
- Be concise — one to two sentences maximum.
- Never include implementation details, source-code notes, or internal aliases.

#### Verb patterns by flag type

| Flag type | Opening pattern | Example |
|-----------|----------------|---------|
| Boolean toggle | `Enable <behaviour>` | `'Enable verbose debug output to stderr'` |
| Boolean skip/suppress | `Skip <behaviour>` | `'Skip automatic database configuration apply'` |
| Destructive gate | `Allow <operation>` | `'Allow destructive schema changes that may result in data loss'` |
| Named value | `<Type> of <thing>` | `'ID of the target Fabric workspace'` |
| Named value with default | `<Description> (defaults to X when omitted)` | `'Workspace display name (defaults to "My Workspace" when omitted)'` |
| Path | `Path to <file description>` | `'Path to .env file for variable interpolation (defaults to rayfin/.env)'` |
| Complex value with example | `<Effect> (e.g. X)` | `'Target workspace by Fabric portal URL (e.g. https://app.fabric.microsoft.com/groups/<id>/list)'` |

#### Canonical descriptions for standard flags

Use these exact descriptions for the standard flags across every command so help text is consistent.

| Flag | Canonical description |
|------|-----------------------|
| `--json` | `'Output result as JSON to stdout'` |
| `-y, --yes` | `'Auto-accept all confirmation prompts'` |
| `--verbose` | `'Enable verbose debug output to stderr'` |
| `--dry-run` | `'Preview operations without creating or modifying resources'` |
| `--force` | `'Allow destructive operations that may result in data loss'` |
| `--env-file <path>` | `'Path to .env file for rayfin.yml interpolation (defaults to rayfin/.env)'` |

#### Examples

Good:

```typescript
.option('--workspace <name>', 'Workspace display name (resolved via the Fabric API; defaults to "My Workspace" when omitted)')
.option('--verbose', 'Enable verbose debug output to stderr')
.option('--force', 'Allow destructive schema changes that may result in data loss')
```

Bad:

```typescript
// Omits where output goes
.option('--verbose', 'Enable verbose output')
// Just restates the flag name
.option('--workspace <name>', 'workspace')
// Implementation detail leaked into user-facing string
.option('-y, --yes', 'Skip the interactive prompt (alias of --non-interactive). Locally re-declared so it works after the subcommand: ...')
// Internal status, should be hidden with .hideHelp() instead
.option('--gen-config-only', 'NOT SUPPORTED for remote operations')
```

### 5.3 Mutually Exclusive Flags

When flags are mutually exclusive (e.g., `--workspace`, `--workspace-id`, `--workspace-uri`),
validate the combination at the start of the action handler and emit a clear error listing
the conflicting flags before any API calls are made.

### 5.4 Kebab-Case for All Flags

All multi-word flags MUST use kebab-case (e.g., `--workspace-id`, not `--workspaceId`).

## 6. Interactive vs Non-Interactive Mode

### 6.1 Detecting Non-Interactive Mode

Use `isInteractive({ yes: cmdOptions.yes })` to determine whether prompts are allowed.
The function returns `false` when any of the following is true:

- `cmdOptions.yes` is `true` (user passed `-y` or `--yes`)
- `process.stdin.isTTY` is falsy (stdin is a pipe or redirected)
- `process.env.CI === 'true'`

### 6.2 Prompting Rules

- NEVER prompt when `isInteractive()` returns `false`.
- For non-interactive mode, either use the flag-provided value or fail with a clear error
  explaining which flag to use.
- Confirmation prompts for destructive operations MUST also be skippable via `--yes`.
- Use `inquirer` for all interactive prompts (consistent with existing commands).

### 6.3 Default Resolution Order

When a value can come from multiple sources, resolve in this priority order:

1. Explicit flag (`--workspace-id <id>`)
2. Environment variable (e.g., `RAYFIN_WORKSPACE_ID`)
3. Deployment registry (existing `.deployments.json` entries)
4. Interactive prompt (only if interactive mode)
5. Well-known default (e.g., "My Workspace")

Document this resolution order in the command's `--help` description.

## 7. Dry-Run Mode

### 7.1 Dry-Run Requirements

A command with `--dry-run` MUST:

- Print a header that states which side effects are disabled.
- List every planned operation as `✓ <description>` bullets.
- Exit with code `0` after a viable plan is displayed.
- Exit nonzero when validation or an allowed read-only lookup fails.
- Make no file writes, state mutations, or mutating API calls.
- Avoid API calls unless the command documents a read-only preview requirement.

`rayfin up` has an explicit read-only target-resolution exception: it authenticates and reads Fabric workspace metadata so the preview includes the actual workspace name and ID.
It must validate deterministic local static-hosting inputs before remote lookup, must not run builds or change project deployment files, and must never provision, update, or delete remote resources.
When a build is configured, its output folder need not exist until after that build runs.
The deployment preview banner is `DRY RUN MODE - No resources will be created or modified`, and resolution or local validation failures exit nonzero.
Commands without an explicit documented read-only exception must make no API calls and should use `DRY RUN MODE - No API calls will be made`.

### 7.2 Dry-Run Output Format

```text
🔍 DRY RUN MODE - No resources will be created or modified

Workspace: "My Workspace" (ID: 00000000-0000-0000-0000-000000000000)

Planned operations:
  ✓ Create or reuse Rayfin item "my-app" (AppBackend)
  ✓ POST runtime settings (auth=true, data=true, storage=false)
  ✓ Generate and apply DAB configuration to workload endpoint
  ✓ Retrieve publishable key
  ✓ Persist deployment metadata to rayfin/.deployments.json
```

## 8. Verbose Mode

### 8.1 Verbose Logging

Use `createVerboseLogger(cmdOptions.verbose)` to obtain a logger that is a no-op when
`--verbose` is not set.

```typescript
const verbose = createVerboseLogger(cmdOptions.verbose);
verbose('Token prefix:', token.substring(0, 20) + '...');
verbose('Full config:', JSON.stringify(config, null, 2));
```

### 8.2 Verbose Content Guidelines

Include in verbose output:

- API endpoint URLs being called.
- HTTP response status codes and durations.
- Resolved IDs and names (workspace ID, item ID).
- Config file paths and resolved values.
- Retry attempts and backoff durations.

Exclude from verbose output:

- Full auth tokens or secrets (truncate to first 20–40 chars + `...`).
- Email addresses or user OIDs.
- Full request/response bodies containing user data.

### 8.3 Verbose Format

Use the `[verbose]` prefix for all verbose lines (produced by `createVerboseLogger`).
For scoped verbose lines within a step, use `[<step-name>]` as an additional prefix:

```text
[verbose] Token prefix: eyJ0eXAiOiJKV1Q...
[verbose] Working directory: /home/user/my-app
[runtime-settings] POST https://.../__private/projectRuntimeSettings
[runtime-settings] Response: 200 OK
```

## 9. Command Structure and Naming

### 9.1 Verb-Noun Command Structure

Commands follow a `<verb> <noun>` pattern:

- `rayfin init` — initialise a project
- `rayfin up` — deploy to cloud
- `rayfin dev` — local development operations
- `rayfin login` / `rayfin logout` — auth operations

Subcommands extend this: `rayfin up db apply`, `rayfin dev storage apply`.

### 9.2 Command Grouping

Group related subcommands under a parent noun:

- `rayfin up db ...` — remote database operations
- `rayfin dev db ...` — local database operations
- `rayfin up storage ...` — remote storage operations
- `rayfin dev storage ...` — local storage operations

The separation between `dev` (local) and `up` (remote) MUST be maintained.
Never add a remote API call to a `dev` subcommand.

### 9.3 Command Descriptions

Every command and subcommand MUST have a `.description()` string that:

- Starts with a capital letter and uses no trailing period.
- Begins with an **imperative verb** for action commands: "Deploy", "List", "Generate", "Display", "Sign in".
- Uses "X operations for Y" or "Manage X" for parent/grouping commands that have no action of their own.
- Distinguishes itself clearly from sibling commands — especially when sibling commands differ only in `dev` vs `up` scope.
- Does not repeat the command name.
- Mentions relevant scope (local vs remote, Fabric vs Docker) where ambiguity exists.
- Adds a second sentence after an em dash only for genuinely important secondary information.

#### Patterns by command role

| Role | Pattern | Example |
|------|---------|---------|
| Simple action | `<Verb> <object>` | `'Sign out and clear cached credentials'` |
| Action with target | `<Verb> <object> to/as/in <context>` | `'Deploy the application to Fabric as a Rayfin item'` |
| Action with scope | `<Verb> <object> to <scope>` | `'Generate and apply DAB configuration to local development server'` |
| Parent / grouping | `<Noun> operations for <scope>` | `'Database operations for remote Rayfin item deployment'` |
| Action with key secondary info | `<Main sentence> — <secondary info>` | `'Switch the active Fabric deployment — rewrites rayfin/.env accordingly'` |
| Idempotent / safe to re-run | `<Action>. Idempotent — <explanation>` | `'Install or refresh Rayfin agent files in this project. Idempotent — re-running updates items whose content has changed'` |

#### Anti-patterns

| Anti-pattern | Bad example | Fix |
|-------------|-------------|-----|
| Just the noun | `'up command'` | `'Deploy the application to Fabric as a Rayfin item'` |
| Vague filler | `'Manage things'` | `'Storage operations for local development'` |
| Does not distinguish sibling | `'Database operations'` | `'Database operations for local development'` |
| Leaks implementation detail | `'Alias of --non-interactive. Locally re-declared so it works after the subcommand'` | Remove internal notes from all user-facing strings |
| Describes a hidden/unsupported option | `'NOT SUPPORTED for remote operations'` | Hide with `.hideHelp()` and omit the description |

### 9.4 Positional Argument Descriptions

When a command accepts a positional argument via `.argument()`, the description MUST follow the same rules as flag descriptions.

- State what the argument represents, not just its placeholder name.
- Document the default value for optional arguments.
- Be concise — one sentence.

Good:

```typescript
.argument('[project-path]', 'Path to the project root directory (defaults to current directory)')
.argument('[workspace]', 'Workspace name or slug to activate')
```

Bad:

```typescript
// Just restates the placeholder
.argument('[project-path]', 'project path')
// Empty description
.argument('[workspace]', '')
```

### 9.5 Adding Invocation Examples to Help Text

For commands with three or more non-trivial flags, add at least one usage example using `.addHelpText('after', ...)`.

The example text MUST:

- Show a complete, runnable command line.
- Use realistic placeholder values — not `<foo>` or `[value]`.
- Show the most common real-world invocation first.
- Be formatted with two-space indentation per line.

```typescript
.addHelpText(
  'after',
  `
Examples:
  rayfin up --workspace "My Workspace"
  rayfin up --workspace-uri https://app.fabric.microsoft.com/groups/abc123/list
  rayfin up --dry-run`,
)
```

## 10. Security and Privacy

### 10.1 Never Log Credentials

Verbose output MUST NOT include full auth tokens, API keys, passwords, or secrets.
Always truncate: `token.substring(0, 20) + '...'`.

### 10.2 Never Log PII

Do not log email addresses, user OIDs, or any other personally identifiable information
even in verbose mode.
Use boolean indicators: `HasEmail=True`, `HasOid=True`.

### 10.3 CliHandledError Prevents Accidental Leaks

When displaying a formatted error, always throw `CliHandledError(originalError)` rather
than re-throwing `originalError`.
This prevents the raw error (which may contain internal URLs, stack traces, or user data)
from being printed a second time by the top-level handler.

### 10.4 ScaffoldCancelledError Has No Constructor Arguments

`ScaffoldCancelledError` takes no arguments by design, preventing user-derived content
(template URLs with tokens, local paths with usernames) from leaking into telemetry.

## 11. Functional Spec Requirements for New CLI Features

When writing an OpenSpec functional spec for a new CLI feature, include the following
sections and scenarios:

### 11.1 Required Sections

1. **Purpose** — What problem does this command solve?
2. **Command signature** — Full command syntax and subcommand tree.
3. **Flags** — All flags with type, default, and description.
4. **Output mode scenarios** — Scenarios for `interactive`, `plain`, and `json`.
5. **Interactive vs non-interactive** — How the command behaves without prompts.
6. **JSON output schema** — Success and error schemas.
7. **Exit codes** — What each exit code means for this command.
8. **Dry-run behaviour** (if applicable) — What is previewed.
9. **Force flag behaviour** (if applicable) — What destructive operations are gated.
10. **Verbose output** — What additional information `--verbose` emits.
11. **Error scenarios** — Key failure modes with expected error messages.
12. **Help text** — Expected `--help` output.

### 11.2 Scenario Format

Write scenarios in the Given/When/Then format used in existing specs:

```markdown
#### Scenario: <name>

- **GIVEN** <precondition>
- **WHEN** <action>
- **THEN** <expected outcome>
- **AND** <additional expected outcome>
```

### 11.3 UX Review Checklist for Specs

Before finalising a spec, verify:

- [ ] All three output modes are covered by scenarios.
- [ ] Error messages include recovery hints.
- [ ] Destructive paths require `--force`.
- [ ] `--json` schema is fully defined for success and error.
- [ ] Exit codes are explicit.
- [ ] Non-interactive path is described.
- [ ] `--dry-run` is specified if the command has side effects.
- [ ] Verbose output is specified.
- [ ] Flag names follow the standard table in Rule 5.1.
- [ ] Flag descriptions document defaults.
- [ ] No PII or credentials appear in example output.

### 11.4 Required spec template for new commands and behavior changes

Use this template verbatim for any new command, subcommand, or behavior change in
an existing command.
Every section is required.

```markdown
## CLI change specification template

### User intent
- Describe when a developer chooses this command and what they need to achieve.

### Behavior contract
- Command responsibility and scope (local vs remote, dev vs up, Fabric vs Docker).
- Inputs: positional arguments, flags, defaults, precedence, and mode-specific behavior.
- Outputs: stdout/stderr contract, interactive/plain/json behavior, and exit codes.

### Validation and failures
- Validation rules for each input and flag combination.
- Failure behavior for invalid input, missing dependencies, auth failures, and denied permissions.

### Error messages (explicit wording)
- Exact `❌` error strings for critical failures.
- Paired recovery hint lines for each error.

### Examples
- Happy-path examples for common usage.
- Edge-case examples (non-interactive, `--json`, `--dry-run`, destructive paths).

### Command responsibility boundaries
- What this command owns and what it must not do.
- Any local vs remote constraints and side-effect boundaries.
- Example: Local `dev` commands must not call remote Fabric APIs.
- Example: `up` commands may call remote APIs but must not modify local Docker state unless documented.

### Cross-cutting surface areas
- SDK/API contract impacts.
- Security and privacy implications (credentials, PII, telemetry handling).
```

### 11.5 Spec validation checklist for review

Use this checklist during review to verify coverage:

- [ ] User intent is explicit and tied to a concrete developer job.
- [ ] Behavior contract defines responsibility, inputs, outputs, and exit codes.
- [ ] Validation rules and failure behavior are specified for invalid input.
- [ ] Error messages include exact wording and recovery hints.
- [ ] Examples include both happy-path and edge-case scenarios.
- [ ] Command responsibility boundaries are explicit (for example, local vs remote).
- [ ] Cross-cutting SDK, security, and privacy implications are documented.

## 12. Existing Patterns to Follow

### 12.1 Key Source Files

| File | Purpose |
|------|---------|
| `src/utils/output-mode.ts` | All output utilities: `modeLog`, `modeError`, `emitJson`, `resolveOutputMode`, `isInteractive`, `createVerboseLogger` |
| `src/errors.ts` | `CliHandledError`, `ScaffoldCancelledError` |
| `src/commands/up/up.ts` | Reference implementation of multi-step command with all three output modes |
| `src/commands/init.ts` | Reference for interactive scaffolding commands |
| `src/commands/up/up-db.ts` | Reference for subcommand with `--json` |

### 12.2 Output Mode Helper Summary

| Function | Purpose |
|----------|---------|
| `resolveOutputMode({ json })` | Determine mode from flag + TTY |
| `isInteractive({ yes })` | Determine if prompts are allowed |
| `createVerboseLogger(enabled)` | No-op logger unless `--verbose` |
| `modeLog(mode, ...)` | Print info (suppressed in json mode) |
| `modeError(mode, ...)` | Print error to stderr |
| `modeWarn(mode, ...)` | Print warning to stderr |
| `emitJson(data)` | Write JSON result to stdout |
| `emitJsonError(mode, message)` | Write JSON error + throw |
| `createProgress(mode, msg)` | Mode-aware `ProgressIndicator` |
| `wrapOraSpinner(spinner, msg)` | Wrap ora with `ProgressIndicator` |
| `formatDuration(ms)` | Format `328` → `"328ms"`, `1900` → `"1.9s"` |
