/**
 * `dev` workflow step: start the local runtimes — the inner-loop constant.
 *
 * Runs *my code* (the frontend dev server + the functions runtime) locally
 * through the {@link CommandRunner} adapter, injecting the backend wiring env
 * plus any per-runtime overrides. This is provider-independent: whichever
 * backend was made ready, my code always runs here.
 *
 * The runtimes are long-running: each `run` resolves only when its process
 * exits or its cancellation token terminates it. A runtime marked
 * {@link LocalRuntimeSpec.required} is load-bearing for the session — if it
 * never launches, or ends while the session is still live, the step cancels its
 * siblings and returns a typed failure so the workflow fails instead of leaving
 * a frontend running against a runtime that is not there. Optional runtimes
 * still degrade to warnings.
 */
import {
  type CancellationToken,
  type CommandRunner,
  type Progress,
  createLinkedCancellation,
} from '../../../adapters/index.js';
import type { Step } from '../../types.js';
import type { LocalRuntimeSpec } from '../runtimes.js';

/** Inputs for {@link startLocalRuntimes}. */
export interface StartLocalRuntimesInput {
  /** The local runtimes to start (frontend + functions). */
  runtimes: LocalRuntimeSpec[];
  /** Backend wiring env injected into every runtime. */
  env: Record<string, string>;
}

/** Capabilities {@link startLocalRuntimes} composes. */
export interface StartLocalRuntimesDeps {
  runner: CommandRunner;
  progress: Progress;
  signal?: CancellationToken;
}

/** Outcome of {@link startLocalRuntimes}. */
export interface StartLocalRuntimesResult {
  /** Ids of the runtimes that launched. */
  started: string[];
  /** Non-fatal warnings raised by optional runtimes. */
  warnings: string[];
  /** Whether the parent session was cancelled while runtimes were active. */
  cancelled: boolean;
  /** Set when a required runtime failed; the workflow maps this to `failed`. */
  failure?: { code: string; message: string };
}

/**
 * Start every local runtime and keep the session alive until they exit or are
 * cancelled. Never throws: an optional runtime that fails is a warning, and a
 * required one is the returned {@link StartLocalRuntimesResult.failure}.
 */
export const startLocalRuntimes: Step<
  StartLocalRuntimesInput,
  StartLocalRuntimesResult,
  StartLocalRuntimesDeps
> = async ({ runtimes, env }, { runner, progress, signal }) => {
  const started: string[] = [];
  const warnings: string[] = [];
  let failure: { code: string; message: string } | undefined;

  // Derived from the session token so a required runtime dying stops its
  // siblings without marking the session itself as user-cancelled — the
  // workflow still needs to tell "Ctrl-C" apart from "we gave up".
  const siblings = createLinkedCancellation(signal);
  const fail = (code: string, message: string): void => {
    failure ??= { code, message };
    siblings.cancel();
  };

  try {
    await Promise.all(
      runtimes.map(async (runtime) => {
        progress.report({
          phase: 'runtimes',
          message: `Starting ${runtime.label}`,
        });
        const result = await runner.run(runtime.command, runtime.args, {
          cwd: runtime.cwd,
          env: runtime.env ? { ...env, ...runtime.env } : env,
          signal: siblings.token,
          inheritStdio: runtime.inheritStdio,
        });

        if (!result.launched) {
          const message = `Could not start ${runtime.label}: ${
            result.spawnError ?? 'the process failed to launch'
          }`;
          if (runtime.required) {
            fail('runtime-launch-failed', message);
          } else {
            warnings.push(message);
          }
          return;
        }

        started.push(runtime.id);

        // A cancelled run reports an unreliable exit code (killed child) and is
        // the expected shape of a clean Ctrl-C shutdown.
        if (result.cancelled) return;

        if (runtime.required) {
          fail(
            'runtime-exited',
            result.exitCode === 0
              ? `${runtime.label} stopped unexpectedly.`
              : `${runtime.label} exited with code ${result.exitCode}.`
          );
          return;
        }

        if (result.exitCode !== 0) {
          warnings.push(
            `${runtime.label} exited with code ${result.exitCode}.`
          );
        }
      })
    );
  } finally {
    siblings.cancel();
    siblings.dispose();
  }

  return {
    started,
    warnings,
    cancelled: signal?.isCancellationRequested === true,
    failure,
  };
};
