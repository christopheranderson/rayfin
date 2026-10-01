#!/usr/bin/env node
/**
 * create-rayfin - thin wrapper around `rayfin init`.
 *
 * All scaffolding logic lives in \@microsoft/rayfin-cli. This entry point
 * imports `init()` from the CLI's _internal export, names the program,
 * wires telemetry, and runs the dispatcher with success/failure/cancel
 * accounting before flushing telemetry on exit.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { init } from '@microsoft/rayfin-cli/_internal/commands/init.js';
import {
  CliHandledError,
  ScaffoldCancelledError,
} from '@microsoft/rayfin-cli/_internal/errors.js';
import { bootstrapEnvironmentConfig } from '@microsoft/rayfin-tools-common/_internal/env-config';

import {
  finalizeCurrentContext,
  getCurrentContext,
  initTelemetry,
  installCommanderHooks,
  markCurrentContextCancelled,
  markCurrentContextFailure,
  shutdownTelemetry,
} from './telemetry/index.js';

// Distinct from 1 (operation failed) so machine consumers can tell
// "user said no" apart from "operation crashed". Mirrors the same
// constant in `@microsoft/rayfin-cli/scripts/main`.
const EXIT_CODE_CANCELLED = 2;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read this package's version from package.json. The relative depth differs
 * between source layout (`src/index.ts` -\> `../package.json`) and built
 * layout (`dist/src/index.js` -\> `../../package.json`), so try both.
 */
function readPackageVersion(): string {
  for (const candidate of ['../../package.json', '../package.json']) {
    try {
      const parsed = JSON.parse(
        readFileSync(resolve(__dirname, candidate), 'utf8')
      ) as { name?: string; version?: string };
      if (
        parsed.name === '@microsoft/create-rayfin' &&
        typeof parsed.version === 'string'
      ) {
        return parsed.version;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0-unknown';
}

/**
 * Entry orchestration: boot telemetry, build the CLI program from the
 * shared `init()` factory, run it, account for the outcome, then flush
 * telemetry. Exported so tests can drive this without invoking the
 * module's auto-run side effect.
 *
 * @returns the desired process exit code:
 *   - `0` — success (or prompt-level Ctrl-C via ExitPromptError)
 *   - `1` — failure (any other thrown error)
 *   - `2` — user-cancelled scaffold (ScaffoldCancelledError) — distinct
 *     from 1 so machine consumers can tell "user said no" apart from
 *     "operation crashed"
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  // Hydrate process.env.RAYFIN_* from any persisted environmentConfig in
  // ~/.rayfin/auth.json so a one-time `rayfin login` survives across
  // `npm create @microsoft/rayfin@latest` invocations. Bootstrap writes
  // nothing to stdout (so it can't corrupt --json output); diagnostics
  // for a corrupt/unreadable auth.json go to stderr. Inherited shell
  // exports always win; missing/malformed state is silent.
  bootstrapEnvironmentConfig();

  try {
    await initTelemetry();
  } catch {
    // Telemetry boot failure must not block scaffolding. Swallow and
    // continue; downstream telemetry calls become no-ops.
  }

  const version = readPackageVersion();
  const program = init({
    createProjectSemantics: true,
    getProjectOriginId: () => getCurrentContext()?.correlationId,
  });
  program.name('create-rayfin');
  program.version(version);
  installCommanderHooks(program, version);

  let exitCode = 0;
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof ScaffoldCancelledError) {
      // User declined an overwrite prompt or otherwise cancelled the
      // scaffold. Telemetry records the dedicated `Canceled` category
      // (no resultSummary forwarded — cancellation messages may be
      // derived from user input, see ScaffoldCancelledError JSDoc).
      // Exit 2 so machine consumers can distinguish "user said no"
      // from "operation crashed". The handler already emitted a
      // friendly message, so we don't print here. Same symbol name as
      // `@microsoft/rayfin-cli`'s `scripts/main` for wrapper symmetry.
      markCurrentContextCancelled();
      exitCode = EXIT_CODE_CANCELLED;
    } else if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nOperation cancelled.');
      finalizeCurrentContext('userFault', 'cancelled by user');
      exitCode = 0;
    } else {
      // Suppress re-print for CliHandledError — the command handler has
      // already shown the user-friendly message. Mirrors the same contract
      // honored by `@microsoft/rayfin-cli`'s scripts/main wrapper.
      const underlying =
        error instanceof CliHandledError ? error.originalError : error;
      const telemetryError =
        underlying instanceof Error
          ? underlying
          : new Error(String(underlying));
      markCurrentContextFailure(telemetryError);
      if (!(error instanceof CliHandledError)) {
        console.error(error instanceof Error ? error.message : String(error));
      }
      exitCode = 1;
    }
  } finally {
    try {
      await shutdownTelemetry();
    } catch {
      // Best-effort flush: never let a telemetry shutdown failure
      // override the command's exit code.
    }
  }

  return exitCode;
}

/**
 * Auto-invoke when this file is executed as a script. Skipped when the
 * module is imported by tests or other tooling.
 *
 * Both sides of the comparison are run through `realpathSync` so the
 * guard works whether the install is direct (registry) or symlinked
 * (rush link / npm link / pnpm link / `npm install -g <local-path>`).
 * Without this, `process.argv[1]` is the symlink path while
 * `import.meta.url` is the realpath, the comparison fails, and the CLI
 * silently exits 0.
 */
function isScriptEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    const argvRealPath = realpathSync(process.argv[1]);
    const moduleRealPath = realpathSync(fileURLToPath(import.meta.url));
    return argvRealPath === moduleRealPath;
  } catch {
    return false;
  }
}

if (isScriptEntry()) {
  void main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
