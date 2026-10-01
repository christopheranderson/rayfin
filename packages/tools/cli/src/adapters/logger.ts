/**
 * CLI implementation of the {@link Logger} adapter.
 *
 * Backs the three human-output levels with `console.*`. Per RFC Rule #2,
 * this `console.*` usage is confined to an adapter impl — workflows and
 * services never call `console.*` directly; they render through `Logger`.
 *
 * In `--output json` mode the host constructs {@link silentLogger} instead
 * of this impl, so the only thing written to stdout is the single JSON
 * payload rendered by Layer 1 from the workflow's `Result`.
 */
import type { Logger } from '@microsoft/rayfin-tools-common/_internal/adapters';

/**
 * Console-backed {@link Logger} for interactive and plain output modes.
 *
 * `log` goes to stdout; `warn` / `error` go to stderr (via `console.warn` /
 * `console.error`) so diagnostics never corrupt a stdout payload.
 */
export const cliLogger: Logger = {
  log(message: string): void {
    console.log(message);
  },
  warn(message: string): void {
    console.warn(message);
  },
  error(message: string): void {
    console.error(message);
  },
};
