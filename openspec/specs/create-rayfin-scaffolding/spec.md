# create-rayfin-scaffolding Specification

## Purpose

`create-rayfin` is a convenience wrapper providing the `npm init @microsoft/create-rayfin` entry point.
It parses arguments and forwards them to `rayfin init`.
All template logic, discovery, and scaffolding are owned by `rayfin init`.

## Requirements

### Requirement: Forward CLI arguments to rayfin init

`create-rayfin` SHALL forward all flags to `rayfin init` unchanged.
The positional `[directory]` argument is interpreted as a create-project target and inherits the non-in-place child-directory semantics below:

- The positional defaults to the resolved project name.
- A bare-name positional with whitespace is slugified for the on-disk directory and used verbatim as the default project name.
- A path-like positional (`./My App`, `../My App`, `/tmp/My App`) is the escape hatch for literal-whitespace directories.
- `--project-name <name>` overrides the project name; when `[directory]` is omitted or in-place-looking, it also supplies the child directory name.

When `create-rayfin` is invoked without a positional `[directory]`, the resolved project name SHALL become the child directory name for template scaffolding.
When `create-rayfin` is invoked with a positional `[directory]`, the positional SHALL be interpreted as a new child project directory input, not as a request to scaffold in-place.
This keeps `npm create @microsoft/rayfin@latest` aligned with scaffold-new-project behavior; in-place scaffolding is owned by `rayfin init`.

`create-rayfin` sets its own package name and version for branding, then delegates to `rayfin init`.

#### Scenario: Interactive mode

- **WHEN** user runs `npm init @microsoft/create-rayfin` without arguments
- **THEN** the system invokes `rayfin init` in interactive mode

#### Scenario: Omitted directory uses resolved project name

- **WHEN** user runs `npm create @microsoft/rayfin@latest` without a directory
- **AND** resolves the project name to `reactapp23`
- **THEN** the on-disk directory is `reactapp23/`
- **AND** the system scaffolds into `reactapp23/`, not the current directory

#### Scenario: Explicit in-place-looking positional still creates child directory

- **WHEN** user runs `npm create @microsoft/rayfin@latest . --project-name reactapp23`
- **THEN** the on-disk directory is `reactapp23/`
- **AND** the system scaffolds into `reactapp23/`, not the current directory

#### Scenario: Forward template flag

- **WHEN** user runs `npm init @microsoft/create-rayfin -- --template todo-app`
- **THEN** the system forwards `--template todo-app` to `rayfin init`

#### Scenario: Forward project name (skips prompt)

- **WHEN** user runs `npm init @microsoft/create-rayfin my-project`
- **THEN** the system treats `my-project` as a child directory argument for `rayfin init`
- **AND** the project-name prompt is skipped (because the positional is a valid bare-name basename)
- **AND** the resulting `rayfin.yml.name` is `my-project`

#### Scenario: Forward whitespace project name (slugifies on-disk directory)

- **WHEN** user runs `npm create @microsoft/rayfin "My App"`
- **THEN** the on-disk directory is `my-app/` (slugified)
- **AND** `rayfin.yml.name` is `"My App"` (display form preserved)
- **AND** the project-name prompt is skipped

#### Scenario: Forward path-like positional (literal directory)

- **WHEN** user runs `npm create @microsoft/rayfin "./My App"`
- **THEN** the on-disk directory is `My App/` (literal whitespace preserved — escape hatch)
- **AND** `rayfin.yml.name` is `"My App"`

### Requirement: Branding

`create-rayfin` SHALL set its own name and version so that help text and error messages display `create-rayfin` instead of `rayfin`.

### Requirement: No additional logic

`create-rayfin` SHALL NOT add flags, prompts, or logic beyond what `rayfin init` provides.
All template selection, scaffolding, dependency installation, and configuration are owned by `rayfin init`.
Refer to the [rayfin-cli-init spec](../rayfin-cli-init/spec.md) and [external-template-sources spec](../external-template-sources/spec.md) for full scaffolding behavior.

#### Scenario: Display project summary

- **WHEN** scaffolding completes
- **THEN** the system shows a summary including template used, files copied, and dependencies installed

### Requirement: Show next steps for in-place scaffolding

When the project was scaffolded in-place (any form recognized by `isInPlaceDirectory`: `.`, `./`, `.\`, `.\\`, absolute-cwd, `./.`, `foo/..`), the system SHALL omit the `cd <project>` line from the Next-steps banner and SHALL display only `npx rayfin dev` and `npm run dev`.

When the project was scaffolded into a child directory, the system SHALL include `cd <directoryForFS>` as the first Next-step, with the path platform-shell-quoted via `formatCdTarget` when it contains shell-significant characters.

#### Scenario: Show next steps for in-place scaffolding (POSIX)

- **WHEN** user runs `npm create @microsoft/rayfin .`
- **AND** scaffolding succeeds
- **THEN** the Next-steps banner displays `npx rayfin dev` and `npm run dev` only
- **AND** the banner does NOT include a `cd` line

#### Scenario: Show next steps for in-place scaffolding (Windows backslash)

- **WHEN** user runs `npm create @microsoft/rayfin .\` (PowerShell shorthand)
- **AND** scaffolding succeeds on Windows
- **THEN** the system treats this as in-place via `isInPlaceDirectory` (resolution-based)
- **AND** the Next-steps banner omits the `cd` line
- **AND** the cwd contents are NOT wiped, even on `--overwrite`

#### Scenario: Show next steps for whitespace-named project

- **WHEN** user runs `npm create @microsoft/rayfin "My App"`
- **AND** scaffolding succeeds
- **THEN** the Next-steps banner shows `cd my-app` (slugified, unquoted because no metacharacters)
- **AND** then `npx rayfin dev` and `npm run dev`

### Requirement: Pre-scaffold project name echo

After project name resolution and before scaffolding starts, the system SHALL emit `🔖 Project name: <resolved>` so the user (or a watching agent) can confirm the resolved name before any disk work occurs.

This is particularly important for whitespace positionals where slugification may be surprising — the echo lets the user catch a wrong name choice before the scaffold completes.

#### Scenario: Echo resolved name before scaffold work

- **WHEN** user runs `create-rayfin "My App"` (or any successful invocation)
- **THEN** the system emits `🔖 Project name: My App` (display form) before any scaffold output

### Requirement: Error Handling (delegated to rayfin init)

The system SHALL handle errors gracefully and provide actionable feedback.
Error handling during scaffolding is implemented by `rayfin init`; `create-rayfin` surfaces exit codes and stderr.

#### Scenario: Handle disk space errors

- **WHEN** insufficient disk space is available during file copying
- **THEN** the system displays a clear error message indicating disk space issue

#### Scenario: Handle permission errors

- **WHEN** file system permission errors occur
- **THEN** the system displays the error and suggests running with appropriate permissions

#### Scenario: Rollback on failure

- **WHEN** an error occurs during scaffolding after files have been copied
- **THEN** the system offers to clean up partially created project directory

#### Scenario: Validate template structure

- **WHEN** a template is selected
- **THEN** the system validates that required files (`package.json`) exist before proceeding

### Requirement: Help and Documentation

The system SHALL provide comprehensive help documentation.
`create-rayfin` owns its own `--help` and `--version` output; other flags are forwarded to `rayfin init`.

#### Scenario: Display help text

- **WHEN** user runs `npm init @microsoft/create-rayfin --help`
- **THEN** the system displays usage information, available flags, and examples

#### Scenario: List available templates

- **WHEN** user runs `npm init @microsoft/create-rayfin --list-templates`
- **THEN** the system displays all available templates with descriptions

#### Scenario: Show version information

- **WHEN** user runs `npm init @microsoft/create-rayfin --version`
- **THEN** the system displays the package version

### Requirement: CLI Output Consistency (delegated to rayfin init)

The system SHALL follow the same output formatting patterns as the rest of the Rayfin CLI for visual consistency.
Output formatting is primarily handled by `rayfin init`.

#### Scenario: Use emoji-based indicators

- **WHEN** displaying status messages, progress, or feedback
- **THEN** the system uses emojis directly (e.g., 🚀, 🔍, ✅, ❌, 🎉, 💡) instead of manual ANSI color codes

#### Scenario: Use ora for progress spinners

- **WHEN** displaying long-running operations or progress feedback
- **THEN** the system uses the `ora` library for spinners with colored output

#### Scenario: Avoid manual ANSI codes

- **WHEN** formatting console output
- **THEN** the system uses plain `console.log()` statements without manually defined ANSI color codes (e.g., `\x1b[36m`)

#### Scenario: Use figlet for headers

- **WHEN** displaying welcome messages or ASCII art headers
- **THEN** the system uses the `figlet` library consistent with other Rayfin CLI commands (e.g., `init.ts`)

### Requirement: Template File Filtering with .templateignore (delegated to rayfin init)

The system SHALL support a `.templateignore` file mechanism to exclude files and folders from template bundling.
Template filtering logic is implemented by `rayfin init`.

#### Scenario: Read .templateignore from template

- **WHEN** bundling a template from samples/ to templates/ directory
- **THEN** the system reads `.templateignore` from the sample directory if it exists

#### Scenario: Parse .templateignore patterns

- **WHEN** `.templateignore` is present
- **THEN** the system parses each line as a glob pattern (similar to .gitignore syntax)

#### Scenario: Exclude files matching .templateignore patterns

- **WHEN** copying template files
- **THEN** the system skips any files/folders matching patterns in `.templateignore`

#### Scenario: Apply default exclusions

- **WHEN** bundling any template (with or without .templateignore)
- **THEN** the system always excludes: `.rush/`, `config/`, `rush-logs/`, `node_modules`, `dist`, `.git`, `.tsbuildinfo`, `.DS_Store`, `.templateignore` which are listed inside the create-rayfin/.templateignore file

#### Scenario: Combine default and template-specific exclusions

- **WHEN** a template has a `.templateignore` file
- **THEN** the system applies both default exclusions from the global .templateignore file in the create-rayfin/.templateignore AND patterns from the `.templateignore` file inside the samples/<sample name>/.templateignore file

#### Scenario: Warn on malformed .templateignore

- **WHEN** `.templateignore` contains invalid glob patterns
- **THEN** the system logs a warning but continues bundling (fallback to default exclusions)

#### Scenario: Template-specific ignores for todo-app

- **WHEN** bundling the `todo-app` template
- **THEN** the template's `.templateignore` excludes `docs/cors-configuration.md` and `docs/todo-app-testing-guide.md`

#### Scenario: Do not include .templateignore in bundled template

- **WHEN** copying template files to templates/ directory
- **THEN** the `.templateignore` file itself is excluded from the bundled template (users don't need it)

### Requirement: Database Dialect Selection (delegated to rayfin init)

> **Partially deferred:** `--dialect` flag forwarding ships in this changeset. Interactive dialect prompt and confirmation flows are deferred to a follow-up. Tracked here for full scope.

The system SHALL prompt users to select their preferred database dialect (MSSQL or PostgreSQL) when creating a new project from a template.
Dialect selection and configuration are implemented by `rayfin init`; `create-rayfin` forwards the `--dialect` flag if provided.

#### Scenario: Display dialect selection prompt

- **WHEN** user runs `npm init @microsoft/create-rayfin` and has selected a template
- **AND** the project name has been collected
- **THEN** the system presents a selection prompt: "Which database dialect would you like to use?"
- **AND** displays two options: "MSSQL" and "PostgreSQL"
- **AND** defaults to "MSSQL" as the first option

#### Scenario: Confirm dialect selection

- **WHEN** user selects a database dialect from the prompt
- **THEN** the system stores the selection for passing to `rayfin init`
- **AND** proceeds with template copying and customization

#### Scenario: Pass dialect to rayfin init

- **WHEN** the system runs `rayfin init --from-template` during template synchronization
- **AND** user has selected a database dialect
- **THEN** the system includes `--dialect <selected-dialect>` in the rayfin init command
- **AND** passes "mssql" for MSSQL selection or "postgresql" for PostgreSQL selection

#### Scenario: Preserve template dialect when not prompted

- **WHEN** dialect prompt is not shown (template doesn't enable data service)
- **THEN** the system runs `rayfin init --from-template` without `--dialect` flag
- **AND** template's default dialect configuration is preserved

#### Scenario: Dialect prompt with template flag

- **WHEN** user runs `npm init @microsoft/create-rayfin --template todo-app`
- **THEN** the system skips the template selection prompt
- **AND** still displays the dialect selection prompt after collecting project name
- **AND** passes the selected dialect to `rayfin init`

#### Scenario: Display consistent prompt styling

- **WHEN** the dialect selection prompt is displayed
- **THEN** it uses the same visual style as other create-rayfin prompts
- **AND** uses `rawlist` prompt type for numbered options
- **AND** displays options with clear labels: "MSSQL" and "PostgreSQL"

### Requirement: Copilot SDK Template Option (delegated to rayfin init)

> **Deferred:** The full Copilot SDK workflow (template option, CLI detection, framework selection, project description collection, session creation, template rework, interactive session, cleanup) is deferred to a follow-up changeset. The `isCopilotTemplate` flag exists in code today only to filter the synthetic copilot entry from `--list-templates` JSON output. Tracked here for full scope.

The system SHALL provide a "Build with GitHub Copilot SDK" template option in the template selection menu.
Template options including the Copilot SDK template are managed by `rayfin init`.

#### Scenario: Display Copilot template in selection

- **WHEN** user runs `npm init @microsoft/rayfin` without specifying a template
- **THEN** the template selection menu includes "Build with GitHub Copilot SDK" alongside other templates

#### Scenario: Copilot template description

- **WHEN** user views the Copilot template option
- **THEN** the description indicates AI-powered project customization using GitHub Copilot

### Requirement: Copilot CLI Detection (delegated to rayfin init)

The system SHALL verify that the GitHub Copilot CLI is installed before proceeding with the Copilot template workflow.
Copilot CLI detection is implemented by `rayfin init`.

#### Scenario: Copilot CLI installed

- **WHEN** user selects the Copilot template
- **AND** the `copilot` command is available in PATH
- **THEN** the system proceeds to framework selection

#### Scenario: Copilot CLI not installed

- **WHEN** user selects the Copilot template
- **AND** the `copilot` command is not available in PATH
- **THEN** the system displays a message prompting the user to install Copilot CLI
- **AND** provides the installation URL: `https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli#installing-or-updating-copilot-cli`
- **AND** the system exits

#### Scenario: User declines to install Copilot CLI

- **WHEN** the Copilot CLI is not installed
- **AND** user declines to install it
- **THEN** the system cancels the scaffolding operation
- **AND** displays a message indicating the Copilot template requires the CLI

### Requirement: Opinionated Framework (delegated to rayfin init)

The system SHALL use the React + shadcn/ui + Radix UI template (`welcome-app-react-ui-components`) as the base for Copilot-assisted scaffolding.
Framework selection is implemented by `rayfin init`.

#### Scenario: Fixed template selection

- **WHEN** Copilot CLI is confirmed available
- **THEN** the system automatically uses `welcome-app-react-ui-components` as the base template
- **AND** does not prompt the user to select a framework

#### Scenario: System message includes framework

- **WHEN** the Copilot session is created
- **THEN** the system message indicates the framework is "React + shadcn/ui + Radix UI"

### Requirement: Project Description Collection (delegated to rayfin init)

The system SHALL collect a natural language project description from the user.
Description collection is implemented by `rayfin init`.

#### Scenario: Description prompt displayed

- **WHEN** Copilot CLI is confirmed available
- **THEN** the system prompts: "Describe the project"
- **AND** accepts multi-line or single-line text input

#### Scenario: Description stored for Copilot

- **WHEN** user provides a project description
- **THEN** the description is passed to the Copilot SDK session as the initial prompt context

### Requirement: Copilot SDK Session Creation (delegated to rayfin init)

The system SHALL create a Copilot SDK session with MCP servers loaded from the project's `.vscode/mcp.json`.
Session creation is implemented by `rayfin init`.

#### Scenario: Session created with MCP servers from project config

- **WHEN** the base template has been scaffolded
- **THEN** the system creates a Copilot SDK session
- **AND** reads MCP server configuration from the project's `.vscode/mcp.json` file
- **AND** adds the `tools: ['*']` property to each server if not present

#### Scenario: Missing mcp.json handled gracefully

- **WHEN** the project does not have a `.vscode/mcp.json` file
- **THEN** the system logs a warning
- **AND** creates the Copilot session without MCP servers

#### Scenario: Custom system message included

- **WHEN** the Copilot session is created
- **THEN** the session includes a system message describing:
  - Rayfin project structure and conventions
  - The welcome-app template being modified
  - Available rayfin-mcp tools (list_docs, get_doc, search_docs) and their usage

#### Scenario: Streaming enabled

- **WHEN** the Copilot session is created
- **THEN** streaming is enabled so responses appear incrementally

### Requirement: Template Rework via Copilot (delegated to rayfin init)

The system SHALL use the Copilot session to rework the scaffolded template based on user input.
Template rework is implemented by `rayfin init`.

#### Scenario: Initial rework prompt

- **WHEN** the session is ready
- **THEN** the system sends a prompt including the project description
- **AND** asks Copilot to rework the template to match the user's vision

#### Scenario: Streaming response display

- **WHEN** Copilot generates a response
- **THEN** the system displays response chunks incrementally as they arrive

#### Scenario: Implementation questions from Copilot

- **WHEN** Copilot needs clarification about implementation details
- **THEN** the system prompts the user for input
- **AND** sends the user's response back to Copilot

### Requirement: Interactive Post-Scaffolding Session (delegated to rayfin init)

The system SHALL maintain an interactive session after initial template rework.
The interactive session is implemented by `rayfin init`.

#### Scenario: Readline prompt displayed

- **WHEN** initial rework is complete
- **THEN** the system displays a `You:` prompt for continued interaction

#### Scenario: User sends follow-up message

- **WHEN** user types a message and presses Enter
- **THEN** the system sends the message to Copilot
- **AND** streams the response with `Assistant:` prefix

#### Scenario: User exits session

- **WHEN** user types `exit`
- **THEN** the system destroys the Copilot session
- **AND** displays the standard "Next steps" message with `cd` and `npm run dev` commands

#### Scenario: Ctrl+C handling

- **WHEN** user presses Ctrl+C during the interactive session
- **THEN** the system gracefully cleans up the Copilot client
- **AND** exits without error

### Requirement: Copilot Session Cleanup (delegated to rayfin init)

The system SHALL properly clean up Copilot SDK resources on exit.
Session cleanup is implemented by `rayfin init`.

#### Scenario: Normal exit cleanup

- **WHEN** user exits via `exit` command
- **THEN** the system calls `session.destroy()` and `client.stop()`

#### Scenario: Error cleanup

- **WHEN** an error occurs during Copilot session
- **THEN** the system attempts to clean up resources in a finally block
- **AND** displays a user-friendly error message

### Requirement: Current Directory Scaffolding (delegated to rayfin init)

The system SHALL accept `.` or `./` as the project name argument to scaffold into the current working directory instead of creating a new subdirectory.
Directory resolution and in-place scaffolding are implemented by `rayfin init`; `create-rayfin` forwards the `.` argument.

#### Scenario: Scaffold with dot argument

- **WHEN** user runs `npm create @microsoft/rayfin@latest .`
- **THEN** the system resolves the project name from the current directory name
- **AND** scaffolds template files into the current directory

#### Scenario: Scaffold with dot-slash argument

- **WHEN** user runs `npm create @microsoft/rayfin@latest ./`
- **THEN** the system behaves identically to the `.` argument

#### Scenario: Resolve project name from directory

- **WHEN** the user provides `.` as the project name
- **AND** the current directory is named `my-cool-app`
- **THEN** the system uses `my-cool-app` as the project name for display and slug generation

#### Scenario: Reject filesystem root

- **WHEN** the user provides `.` as the project name
- **AND** the current directory is the filesystem root (e.g., `C:\` or `/`)
- **THEN** the system SHALL display an error: "Cannot scaffold into the filesystem root"
- **AND** exit with a non-zero exit code

#### Scenario: Resolved name must pass validation

- **WHEN** the user provides `.` as the project name
- **AND** the current directory name does not pass `isValidProjectName()` validation
- **THEN** the system SHALL display the standard invalid project name error
- **AND** exit with a non-zero exit code

#### Scenario: Target path is current directory

- **WHEN** scaffolding in-place with `.`
- **THEN** the system SHALL use the current working directory as the target path
- **AND** SHALL NOT create a new subdirectory

#### Scenario: Conflict prompt for non-empty directory

- **WHEN** scaffolding in-place with `.`
- **AND** the current directory contains existing files
- **THEN** the system SHALL prompt the user to confirm overwrite
- **AND** if the user declines, the system cancels without modifying any files

#### Scenario: Empty pre-existing target directory proceeds without prompting

- **WHEN** scaffolding into a target directory (in-place via `.` or named, e.g. `my-app`) that exists but is empty (`readdirSync` returns zero entries)
- **THEN** the system SHALL proceed with scaffolding without prompting for overwrite confirmation
- **AND** SHALL NOT require the `--overwrite` flag in non-interactive mode
- **AND** SHALL NOT emit the `is not empty and overwrite was declined` cancellation message

This delegates to the same `checkTargetConflict` helper documented in the [rayfin-cli-init spec](../rayfin-cli-init/spec.md). A pre-existing target containing only `.git/`, `.DS_Store`, or any other dotfile/metadata entry is considered non-empty and SHALL trigger the conflict prompt.

#### Scenario: No directory deletion on overwrite

- **WHEN** scaffolding in-place with `.`
- **AND** the user confirms overwrite of a non-empty directory
- **THEN** the system SHALL NOT delete the directory before copying template files
- **AND** SHALL merge template files into the existing directory

#### Scenario: No cleanup on error

- **WHEN** scaffolding in-place with `.`
- **AND** an error occurs during template copying or dependency installation
- **THEN** the system SHALL NOT attempt to delete the current directory
- **AND** SHALL display the error message
