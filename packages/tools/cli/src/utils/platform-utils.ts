/**
 * Centralized cross-platform utilities for the Rayfin CLI.
 *
 * All platform-specific logic (command names, path separators, spawn
 * behaviour) lives here so that consumers never need to branch on
 * `process.platform` themselves and the branching can be tested in one place.
 */

import {
  spawn,
  spawnSync,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
  type ChildProcess,
} from 'child_process';

/** `true` when running on Windows (any architecture). */
export const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Command-name helpers
// ---------------------------------------------------------------------------

/**
 * Return the platform-correct executable name for a given tool.
 *
 * On Windows, npm / npx must be invoked as `npm.cmd` / `npx.cmd` when
 * spawning without `shell: true`.  On Unix-like systems the bare name works.
 *
 * @param name - The base name of the command (e.g. `'npm'`, `'npx'`).
 * @returns The platform-appropriate command string.
 */
export function getPlatformCommand(name: string): string {
  if (!isWindows) {
    return name;
  }

  // Well-known commands that need the .cmd extension on Windows.
  // These are tools whose Windows installers ship a `.cmd` shim instead
  // of a real `.exe`, so Node's bare-name spawn (without PATHEXT) would
  // fail with ENOENT. Mapping them to the `.cmd` form also lets
  // `spawnSafe` / `spawnSyncSafe` engage their internal `shell: true`
  // path (required by Node.js v22+ for `.cmd` / `.bat` files) without
  // the caller having to know.
  const cmdExtensionNames = new Set(['npm', 'npx', 'pnpm', 'yarn', 'tsc']);
  if (cmdExtensionNames.has(name)) {
    return `${name}.cmd`;
  }

  return name;
}

// ---------------------------------------------------------------------------
// Path / environment separator
// ---------------------------------------------------------------------------

/**
 * The separator used by composed environment variables on the current platform.
 *
 * Docker Compose's `COMPOSE_FILE` uses `;` on Windows and `:` on Unix.
 * Node's own `path.delimiter` follows the same convention, but this constant
 * makes the intent explicit and keeps the value testable.
 */
export const pathListSeparator: string = isWindows ? ';' : ':';

// ---------------------------------------------------------------------------
// Safe spawn wrapper
// ---------------------------------------------------------------------------

/**
 * Commands that may exist as either `.cmd` (npm global) or `.exe` (MSI/winget)
 * on Windows.  These are NOT appended with `.cmd` — instead, they are spawned
 * with the bare name under `shell: true` so that cmd.exe's PATHEXT resolution
 * finds whichever variant is installed.
 */
const shellResolvedNames = new Set([
  'func', // Azure Functions Core Tools — `func.cmd` (npm) or `func.exe` (winget/MSI)
]);

const PROCESS_TREE_KILL_GRACE_MS = 2_000;

/**
 * Returns `true` when a spawn call needs `shell: true` on Windows.
 *
 * This is required for:
 * 1. Commands resolved to `.cmd`/`.bat` — Node.js v22+ throws EINVAL otherwise.
 * 2. Commands in {@link shellResolvedNames} — need PATHEXT to find `.cmd` or `.exe`.
 */
export function needsWindowsShell(
  command: string,
  resolvedCommand: string
): boolean {
  if (!isWindows) return false;
  return (
    /\.(cmd|bat)$/i.test(resolvedCommand) || shellResolvedNames.has(command)
  );
}

/**
 * Options for {@link spawnSafe}.  Extends the standard Node `SpawnOptions`
 * but deliberately omits `shell` — `spawnSafe` manages `shell` internally,
 * enabling it only for `.cmd`/`.bat` files on Windows (required by Node.js v22+).
 */
export type SafeSpawnOptions = Omit<SpawnOptions, 'shell'>;

/**
 * Wrap a Windows shell argument in double quotes.
 *
 * Windows paths and flags passed to `.cmd`/`.bat` files via `shell: true` must
 * be quoted to prevent word-splitting on spaces.  The only transformation
 * needed is doubling any trailing backslashes — a trailing `\` would otherwise
 * escape the closing `"` and produce a malformed argument.  Backslashes
 * elsewhere in a Windows path are followed by alphanumeric characters (path
 * separators), not by `"`, so they do not need escaping.
 *
 * Windows file-system paths cannot contain `"` (NTFS/FAT32 prohibit it), and
 * the other arguments passed through {@link spawnSafe} are plain flags or
 * identifiers that also contain no `"`.  No `"` escaping is therefore needed.
 *
 * @internal Exported for unit testing only.
 */
export function quoteWindowsArg(arg: string): string {
  // Count trailing backslashes via a linear scan rather than the regex
  // `(\\+)$` to avoid the polynomial-backtracking risk CodeQL flags on
  // adversarial inputs. Behaviour is identical: every trailing backslash
  // is doubled so it is not consumed as an escape character for the
  // closing double-quote we are about to append.
  let trailing = 0;
  for (let i = arg.length - 1; i >= 0 && arg[i] === '\\'; i--) {
    trailing++;
  }
  const head = arg.slice(0, arg.length - trailing);
  return `"${head}${'\\'.repeat(trailing * 2)}"`;
}

/**
 * Spawn a child process with safe defaults.
 *
 * This wrapper:
 * 1. Resolves the correct platform executable name via {@link getPlatformCommand}.
 * 2. Passes `windowsHide: true` by default so console windows don't flash.
 * 3. Enables `shell: true` only for `.cmd`/`.bat` files on Windows, which is
 *    required by Node.js v22+ (otherwise spawn throws EINVAL).  Arguments are
 *    individually quoted so that paths containing spaces are not word-split.
 *
 * @param command - The base command name (e.g. `'npm'`). Will be mapped to
 *   `'npm.cmd'` on Windows automatically.
 * @param args - Argument list forwarded to `child_process.spawn`.
 * @param options - Standard `SpawnOptions` minus `shell`.
 * @returns The `ChildProcess` handle.
 */
export function spawnSafe(
  command: string,
  args: readonly string[],
  options: SafeSpawnOptions = {}
): ChildProcess {
  const resolvedCommand = getPlatformCommand(command);
  // On Windows, .cmd/.bat files require shell: true in Node.js v22+ (EINVAL fix).
  // Shell-resolved commands also need shell: true for PATHEXT resolution.
  // When using shell mode, quote each argument to protect paths with spaces.
  const useShell = needsWindowsShell(command, resolvedCommand);
  const safeArgs = useShell ? args.map(quoteWindowsArg) : (args as string[]);
  return spawn(resolvedCommand, safeArgs, {
    ...options,
    shell: useShell,
    windowsHide: options.windowsHide ?? true,
  });
}

/**
 * Terminate a spawned process and every descendant it created.
 *
 * POSIX callers must spawn the child with `detached: true`, making its PID a
 * process-group id that can be signalled as a unit. Windows uses `taskkill /T`
 * because Node does not expose Job Objects through `child_process`.
 */
export function terminateProcessTree(
  child: ChildProcess,
  signal: Parameters<ChildProcess['kill']>[0] = 'SIGTERM',
  warn: (message: string) => void = (): void => {}
): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(signal);
    return;
  }

  if (isWindows) {
    terminateWindowsProcessTree(child, pid, signal, warn);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
    return;
  }

  if (signal === 'SIGKILL' || signal === 9) return;
  const forceKillGroup = (): void => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The process group exited during the grace period.
    }
  };
  const forceKill = setTimeout(forceKillGroup, PROCESS_TREE_KILL_GRACE_MS);
  child.once('exit', () => {
    clearTimeout(forceKill);
    // The leader exited, so kill any descendants still in its original group
    // immediately rather than leaving a timer that could outlive that group.
    forceKillGroup();
  });
  forceKill.unref();
}

interface TaskkillResult {
  error?: Error;
  status: number | null;
}

type TaskkillRunner = (pid: number) => TaskkillResult;

const runTaskkill: TaskkillRunner = (pid) => {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return { error: result.error, status: result.status };
};

/** `taskkill` exit status when the target PID no longer exists. */
const TASKKILL_PROCESS_NOT_FOUND = 128;

/** @internal Exported to test the Windows fallback on non-Windows CI. */
export function terminateWindowsProcessTree(
  child: ChildProcess,
  pid: number,
  signal: Parameters<ChildProcess['kill']>[0],
  warn: (message: string) => void,
  taskkill: TaskkillRunner = runTaskkill
): void {
  const result = taskkill(pid);
  if (!result.error && result.status === 0) return;
  // Console Ctrl+C reaches children that share the terminal, so they often
  // exit before this runs; `child.exitCode` is not updated yet because
  // `spawnSync` blocks the event loop.
  if (!result.error && result.status === TASKKILL_PROCESS_NOT_FOUND) return;

  warn(
    `Could not terminate the process tree for PID ${pid}; a stray \`func\` or \`node\` process may remain.`
  );
  child.kill(signal);
}

/**
 * Options for {@link spawnSyncSafe}. Mirrors {@link SafeSpawnOptions}.
 */
export type SafeSpawnSyncOptions = Omit<SpawnSyncOptions, 'shell'>;

/**
 * Synchronous counterpart of {@link spawnSafe}.
 *
 * Same resolution / quoting / shell rules apply. Use this instead of
 * `child_process.spawnSync(..., { shell: true })` to avoid the Node.js
 * v22+ deprecation warning DEP0190 ("Passing args to a child process
 * with shell option true …") while still resolving Windows-only `.cmd`
 * / `.bat` entry points via PATHEXT.
 *
 * @param command - The base command name (e.g. `'func'`).
 * @param args - Argument list forwarded to `child_process.spawnSync`.
 * @param options - Standard `SpawnSyncOptions` minus `shell`.
 * @returns The {@link SpawnSyncReturns} buffer.
 */
export function spawnSyncSafe(
  command: string,
  args: readonly string[],
  options: SafeSpawnSyncOptions = {}
): SpawnSyncReturns<Buffer | string> {
  const resolvedCommand = getPlatformCommand(command);
  const useShell = needsWindowsShell(command, resolvedCommand);
  const safeArgs = useShell ? args.map(quoteWindowsArg) : (args as string[]);
  return spawnSync(resolvedCommand, safeArgs, {
    ...options,
    shell: useShell,
    windowsHide: options.windowsHide ?? true,
  });
}
