# cli-tty-detection Specification

## Purpose

Automatic TTY detection that suppresses ANSI spinner animations and user-facing console output in non-interactive environments, replacing them with plain-text progress lines or silent operation.
Applies to all CLI commands and their utility functions.

## Requirements

### Requirement: Automatic TTY detection for spinner suppression

The CLI SHALL detect whether stdout is a TTY and automatically adjust progress output format across all commands.

**ID**: `CLI-TTY-DETECT-001`

#### Scenario: Non-TTY stdout suppresses spinners

- **WHEN** a user runs any CLI command and `process.stdout.isTTY` is `false` (e.g., piped output, child_process)
- **THEN** the CLI SHALL NOT emit any ANSI escape sequences or spinner animation characters
- **AND** the CLI SHALL emit plain-text progress lines to stderr in the format: `[rayfin <command>] <step description>... done (<duration>)`

#### Scenario: TTY stdout preserves interactive spinners

- **WHEN** a user runs any CLI command in an interactive terminal where `process.stdout.isTTY` is `true`
- **THEN** the CLI SHALL display ora spinners with emoji as normal
- **AND** there SHALL be no change in behavior from the interactive implementation

#### Scenario: --json overrides TTY detection

- **WHEN** a user runs a command with `--json` regardless of TTY status
- **THEN** JSON mode SHALL take precedence over TTY detection
- **AND** all output SHALL follow the JSON output specification (no spinners, no plain-text progress)

### Requirement: Plain-text progress format

In non-TTY mode, progress output SHALL follow a consistent, parseable format.

**ID**: `CLI-TTY-PLAIN-FORMAT-001`

#### Scenario: Progress line format

- **WHEN** a command step begins and completes in non-TTY mode
- **THEN** the CLI SHALL emit a line to stderr in the format: `[rayfin <command>] <Step description>... done (<duration>)`
- **AND** the duration SHALL be formatted as human-readable (e.g., `328ms`, `1.9s`, `4.86s`)

#### Scenario: Progress line on failure

- **WHEN** a command step fails in non-TTY mode
- **THEN** the CLI SHALL emit a line to stderr in the format: `[rayfin <command>] <Step description>... FAILED (<duration>)`
- **AND** the error details SHALL follow on subsequent lines

### Requirement: Mode-aware output for all commands

All CLI command handlers and their utility functions SHALL use the shared `output-mode.ts` utilities for console output.

**ID**: `CLI-TTY-MODE-AWARE-001`

#### Scenario: Command handlers use modeLog

- **WHEN** a command handler needs to emit user-facing status messages
- **THEN** it SHALL use `modeLog(mode, ...)` instead of `console.log(...)`
- **AND** it SHALL use `modeError(mode, ...)` instead of `console.error(...)`

#### Scenario: Utility functions accept OutputMode

- **WHEN** a utility function (e.g., `applyDbConfig`, `applyStorageConfig`, `applyConfigToServer`) produces user-facing output
- **THEN** it SHALL accept an optional `mode?: OutputMode` parameter
- **AND** it SHALL resolve the mode via `resolveOutputMode()` if not provided

#### Scenario: Shared utilities prevent duplication

- **WHEN** multiple commands need verbose logging, JSON output, or progress indicators
- **THEN** they SHALL import shared utilities from `output-mode.ts` (`createVerboseLogger`, `emitJson`, `emitJsonError`, `createProgress`, `wrapOraSpinner`)
- **AND** they SHALL NOT define local copies of these utilities
