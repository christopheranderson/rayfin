/**
 * CLI implementations of the {@link Progress} adapter.
 *
 * Push-style: workflows call `report` as they advance and the host renders
 * (or silences) each update. The CLI resolves rendering mode once in Layer 1
 * (`cli/src/index.ts`) and constructs the matching impl:
 *
 *   - **interactive** — drive an ora spinner whose text tracks the latest
 *     update (with a `phase` prefix and an optional `percent`);
 *   - **plain** — emit one `[rayfin] <phase>: <message>` line per update to
 *     stderr, so stdout stays clean for piping;
 *   - **json** — silent no-op, so the only stdout output is the single JSON
 *     payload Layer 1 renders from the workflow's `Result`.
 *
 * Per RFC Rule #2 these ora / `process.stderr` concerns are confined to an
 * adapter impl. Cancellation is a separate adapter ({@link
 * @microsoft/rayfin-tools-common/_internal/adapters#CancellationToken}); a
 * workflow that cancels declares it in `Deps` directly and never reaches it
 * through `Progress`.
 */
import type {
  Diagnostics,
  Progress,
  ProgressUpdate,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { Ora } from 'ora';

/** Compose a single human-readable line from a progress update. */
function formatUpdate(update: ProgressUpdate): string {
  const parts: string[] = [];
  if (update.phase) {
    parts.push(update.phase);
  }
  if (update.message) {
    parts.push(update.message);
  }
  const base = parts.join(': ') || 'working';
  return update.percent === undefined ? base : `${base} (${update.percent}%)`;
}

/**
 * Interactive {@link Progress} that updates an ora spinner's text on each
 * report. The host owns the spinner's start/stop lifecycle; this adapter only
 * mutates its text.
 */
export function createOraProgress(spinner: Ora): Progress {
  return {
    report(update: ProgressUpdate): void {
      spinner.text = formatUpdate(update);
    },
  };
}

/** Plain-text {@link Progress} that writes one stderr line per update. */
export const plainProgress: Progress = {
  report(update: ProgressUpdate): void {
    process.stderr.write(`[rayfin] ${formatUpdate(update)}\n`);
  },
};

/** Send structured progress to a host-selected diagnostic sink. @internal */
export function createDiagnosticProgress(
  diagnostics: Diagnostics,
  area: string
): Progress {
  return {
    report(update): void {
      diagnostics.debug({
        area,
        message: update.message ?? update.phase ?? 'Working',
        data: {
          ...(update.phase !== undefined ? { phase: update.phase } : {}),
          ...(update.percent !== undefined ? { percent: update.percent } : {}),
        },
      });
    },
  };
}

/** Silent {@link Progress} for `--output json` mode (and tests). */
export const silentProgress: Progress = {
  report(): void {},
};
