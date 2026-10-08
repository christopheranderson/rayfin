/**
 * Output mode utilities for CLI commands.
 *
 * Provides three output modes:
 * - `interactive`: Full ora spinners with emoji (TTY terminals)
 * - `plain`: Plain-text progress lines to stderr (non-TTY, e.g. CI or agent piping)
 * - `json`: Silent operation, single JSON object to stdout on completion
 */

import type { Command } from 'commander';
import ora from 'ora';

import { CliHandledError } from '../errors.js';

/**
 * Walks to the root `Command` and returns the root-level `--verbose` /
 * `--json` flags. Used by every action handler to honor root-level
 * `rayfin --verbose <subcommand>` / `rayfin --json <subcommand>`
 * invocations.
 *
 * Why this helper exists (Commander quirk):
 *
 * When a parent AND child command both declare the same option name
 * (which is the case here — every subcommand keeps its `--verbose` /
 * `--json` for back-compat per the issue), Commander stores the parsed
 * value on the PARENT's option object regardless of where the user
 * typed the flag. The child's `command.opts().verbose` therefore stays
 * at its `false` default, and any code path that reads `options.verbose`
 * or `command.opts().verbose` from inside a subcommand action handler
 * will silently miss a root-level invocation.
 *
 * `command.optsWithGlobals()` (per Commander v12 source: "globals
 * overwrite locals") would also return the correct value for our
 * duplicate-declared case — it walks the ancestor chain leaf → root
 * and lets later writes win, so the root's `true` overrides the leaf's
 * `false` default. This helper is preferred over `optsWithGlobals()`
 * for two reasons:
 *
 *   - It is narrower: it returns ONLY the two flags we care about,
 *     not the full merged option bag of every ancestor (which can
 *     include unrelated parent-group flags like `--env-file`).
 *   - It is self-documenting: the call site reads as "give me the
 *     root-level output flags," which signals intent better than a
 *     generic globals merge.
 *
 * Importantly, neither approach plays nicely with `??`: the local
 * default is `false`, not `undefined`, so
 * `options.verbose ?? optsWithGlobals().verbose` evaluates to `false`
 * and silently breaks inheritance. Call sites must OR (`||`) local
 * with the resolved root value, which falls through `false` correctly:
 *
 * ```ts
 * const root = resolveRootOutputFlags(command);
 * const json = Boolean(options.json) || root.json;
 * const verbose = Boolean(options.verbose) || root.verbose;
 * ```
 */
export function resolveRootOutputFlags(command: Command): {
  verbose: boolean;
  json: boolean;
  output?: OutputMode;
} {
  let cmd: Command = command;
  while (cmd.parent) {
    cmd = cmd.parent;
  }
  const opts = cmd.opts() as {
    verbose?: boolean;
    json?: boolean;
    output?: OutputMode;
  };
  return {
    verbose: Boolean(opts.verbose),
    json: Boolean(opts.json),
    output: opts.output,
  };
}

/**
 * Returns `true` if the named boolean flag was set on any command in the
 * chain (leaf → root). Placement-independent: when the same flag (e.g.
 * `--yes`) is declared on both a subcommand and the root, Commander may
 * store the value on any command's bag while others keep their `false`
 * default, so no single bag (`opts()` or `optsWithGlobals()`) is reliable.
 * OR-ing across the chain is safe because all declared defaults are `false`.
 */
export function resolveInheritedBooleanFlag(
  command: Command,
  name: string
): boolean {
  let cmd: Command | undefined = command;
  while (cmd) {
    const value = (cmd.opts() as Record<string, unknown>)[name];
    if (value === true) {
      return true;
    }
    cmd = cmd.parent ?? undefined;
  }
  return false;
}

/**
 * Output mode for CLI progress display.
 *
 * `'silent'` is a caller-supplied mode (never returned by `resolveOutputMode`)
 * that suppresses all `modeLog`/`modeError`/`modeWarn` output. The v2 `up`
 * services pass it to the wrapped legacy utils so their status lines do not
 * interleave with the Layer 1 spinner (the spinner already conveys phase).
 */
export type OutputMode = 'interactive' | 'plain' | 'json' | 'silent';

/**
 * Runtime-constant companion to {@link OutputMode}, so call sites can write
 * `OUTPUT_MODE.Json` instead of the magic string literal `'json'`.
 */
export const OUTPUT_MODE = {
  Interactive: 'interactive',
  Plain: 'plain',
  Json: 'json',
  Silent: 'silent',
} as const satisfies Record<string, OutputMode>;

/**
 * Resolves the output mode based on command options and environment.
 *
 * Priority: explicit `--output <mode>` \> `--json` flag (back-compat) \> TTY
 * detection. The `--json` alias is retained until every command adopts
 * `--output`; it maps to `json`.
 */
export function resolveOutputMode(options: {
  json?: boolean;
  output?: OutputMode;
}): OutputMode {
  if (options.output) {
    return options.output;
  }
  if (options.json) {
    return 'json';
  }
  if (!process.stdout.isTTY) {
    return 'plain';
  }
  return 'interactive';
}

/**
 * The single standard resolver for a leaf command's shared output/UX flags.
 * Every command should call this instead of hand-rolling flag resolution.
 *
 * - Reads `--json`, `--verbose`, and `--yes` placement-independently (before
 *   or after the subcommand); see {@link resolveInheritedBooleanFlag}.
 * - Folds root `--output <mode>` into the effective {@link OutputMode}.
 * - Enforces the `--verbose` + JSON contract (R6) up front, before any work.
 *
 * @throws CliHandledError when verbose output is combined with JSON output.
 */
export function resolveCommandFlags(command: Command): {
  mode: OutputMode;
  verbose: boolean;
  json: boolean;
  yes: boolean;
} {
  const json = resolveInheritedBooleanFlag(command, 'json');
  const verbose = resolveInheritedBooleanFlag(command, 'verbose');
  const yes = resolveInheritedBooleanFlag(command, 'yes');
  const { output } = resolveRootOutputFlags(command);
  const mode = resolveOutputMode({ json, output });

  if (mode === 'json' && verbose) {
    // `emitJsonError` emits the structured error (json mode) and throws.
    emitJsonError(mode, '`--verbose` cannot be combined with `--json`.');
  }

  return { mode, verbose, json, yes };
}

/** A progress indicator that can succeed, fail, stop, and restart */
export interface ProgressIndicator {
  succeed: (message?: string) => void;
  fail: (message?: string) => void;
  stop: () => void;
  start: () => void;
  /**
   * Print a message above the spinner without garbling output.
   * Clears the spinner line, writes the message, then re-renders.
   * Falls back to `console.log` for non-interactive indicators.
   */
  log: (message: string) => void;
  /** Duration in ms since the indicator was created */
  getDuration: () => number;
  /** Human-readable duration string (e.g. "328ms", "1.9s") */
  getDurationStr: () => string;
}

/** Format a duration in ms to a human-readable string */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Creates a no-op progress indicator for JSON mode.
 * Tracks timing but emits no output.
 */
function createSilentProgress(): ProgressIndicator {
  const startTime = Date.now();
  const getDuration = () => Date.now() - startTime;
  const getDurationStr = () => formatDuration(getDuration());
  return {
    succeed: () => {},
    fail: () => {},
    stop: () => {},
    start: () => {},
    log: () => {},
    getDuration,
    getDurationStr,
  };
}

/**
 * Creates a plain-text progress indicator for non-TTY mode.
 * Writes progress lines to stderr so stdout stays clean.
 */
function createPlainProgress(
  message: string,
  prefix = '[rayfin up]'
): ProgressIndicator {
  const startTime = Date.now();
  const getDuration = () => Date.now() - startTime;
  const getDurationStr = () => formatDuration(getDuration());

  return {
    succeed: (successMessage?: string) => {
      const label = successMessage || message;
      process.stderr.write(
        `${prefix} ${label}... done (${getDurationStr()})\n`
      );
    },
    fail: (errorMessage?: string) => {
      const label = errorMessage || `Failed: ${message}`;
      process.stderr.write(
        `${prefix} ${label}... FAILED (${getDurationStr()})\n`
      );
    },
    stop: () => {},
    start: () => {},
    log: (msg: string) => process.stderr.write(`${msg}\n`),
    getDuration,
    getDurationStr,
  };
}

/**
 * Creates a mode-aware progress indicator.
 *
 * - `interactive`: Returns an ora spinner (caller must provide the factory)
 * - `plain`: Writes `[rayfin up] <message>... done (<duration>)` to stderr
 * - `json` / `silent`: Silent no-op that only tracks timing
 */
export function createProgress(
  mode: OutputMode,
  message: string,
  options?: { emoji?: string; prefix?: string }
): ProgressIndicator {
  if (mode === 'json' || mode === 'silent') {
    return createSilentProgress();
  }
  if (mode === 'plain') {
    return createPlainProgress(message, options?.prefix);
  }
  // Interactive mode — defer to caller (up.ts uses ora)
  // This should not be called directly for interactive mode;
  // use createOraProgressIndicator() instead.
  return createPlainProgress(message, options?.prefix);
}

/**
 * Creates an ora spinner progress indicator for `interactive` mode.
 * Shared by every command that supports interactive mode, so the spinner
 * setup lives in one place instead of being reimplemented per command.
 */
export function createOraProgressIndicator(
  message: string,
  emoji = '🔄'
): ProgressIndicator {
  const spinner = ora({
    text: `${emoji} ${message}...`,
    color: 'blue',
  }).start();
  return wrapOraSpinner(spinner, message);
}

/**
 * Creates a mode-aware progress spinner shared by commands that need a
 * `<emoji> <message>...` spinner in `interactive` mode, an ora spinner on
 * stderr in `json` mode (so stdout stays pure JSON), and a plain stderr line
 * otherwise. Centralizes the pattern previously duplicated per-command.
 */
export function createModeAwareSpinner(
  mode: OutputMode,
  message: string,
  emoji = '🔄',
  options?: { prefix?: string }
): ProgressIndicator {
  if (mode === OUTPUT_MODE.Json) {
    const spinner = ora({
      text: `${emoji} ${message}...`,
      color: 'blue',
      stream: process.stderr,
    }).start();
    return wrapOraSpinner(spinner, message);
  }
  if (mode !== OUTPUT_MODE.Interactive) {
    return createProgress(mode, message, { prefix: options?.prefix });
  }
  return createOraProgressIndicator(message, emoji);
}

/**
 * Wraps an ora spinner to match the ProgressIndicator interface.
 */
export function wrapOraSpinner(
  spinner: {
    succeed: (t: string) => void;
    fail: (t: string) => void;
    stop: () => void;
    start: () => void;
    clear: () => unknown;
    render: () => unknown;
  },
  message: string
): ProgressIndicator {
  const startTime = Date.now();
  const getDuration = () => Date.now() - startTime;
  const getDurationStr = () => formatDuration(getDuration());

  return {
    succeed: (successMessage?: string) =>
      spinner.succeed(`${successMessage || message} (${getDurationStr()})`),
    fail: (errorMessage?: string) =>
      spinner.fail(
        `${errorMessage || `Failed: ${message}`} (${getDurationStr()})`
      ),
    stop: () => spinner.stop(),
    start: () => spinner.start(),
    log: (msg: string) => {
      spinner.clear();
      process.stdout.write(`${msg}\n`);
      spinner.render();
    },
    getDuration,
    getDurationStr,
  };
}

/**
 * Mode-aware console.log — suppressed in JSON mode.
 * In plain mode, writes to stderr to keep stdout clean for JSON.
 */
export function modeLog(mode: OutputMode, ...args: any[]): void {
  if (mode === 'json' || mode === 'silent') return;
  if (mode === 'plain') {
    process.stderr.write(args.map(String).join(' ') + '\n');
    return;
  }
  console.log(...args);
}

/**
 * Mode-aware console.error — suppressed in JSON mode.
 */
export function modeError(mode: OutputMode, ...args: any[]): void {
  if (mode === 'json' || mode === 'silent') return;
  console.error(...args);
}

/**
 * Mode-aware console.warn — suppressed in JSON mode.
 */
export function modeWarn(mode: OutputMode, ...args: any[]): void {
  if (mode === 'json' || mode === 'silent') return;
  console.warn(...args);
}

/**
 * Emit a JSON result to stdout. Used in --json mode on completion.
 *
 * Compact (no whitespace) by design - `--json` is for machine consumption,
 * and pretty-printing wastes ~25-30% of bytes for a piped LLM agent or
 * CI parser. Use `jq` if a human needs a pretty view.
 */
export function emitJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

/**
 * Emit a JSON error and exit. Use in --json mode for early error exits.
 * Only emits JSON when mode is 'json'; always exits with the given code.
 */
export function emitJsonError(
  mode: OutputMode,
  error: string,
  extra?: Record<string, unknown>,
  cause?: unknown
): never {
  if (mode === 'json') {
    emitJson({ status: 'error', error, ...extra });
  }
  throw new CliHandledError(cause ?? new Error(error));
}

/**
 * Determines whether the CLI is running in interactive mode.
 * Returns false when:
 * - `--yes` flag is set (options.yes === true)
 * - stdin is not a TTY (process.stdin.isTTY is falsy)
 * - CI environment variable is set to 'true'
 */
export function isInteractive(options: { yes?: boolean } = {}): boolean {
  if (options.yes) {
    return false;
  }
  if (!process.stdin.isTTY) {
    return false;
  }
  if (process.env.CI === 'true') {
    return false;
  }
  return true;
}

/**
 * Creates a verbose logger that only prints when enabled.
 * Shared across CLI commands to avoid duplication.
 */
export const createVerboseLogger = (enabled: boolean) => {
  return (...args: any[]) => {
    if (enabled) {
      console.log('[verbose]', ...args);
    }
  };
};
