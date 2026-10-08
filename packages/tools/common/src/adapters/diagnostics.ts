/** A single structured diagnostic event emitted by a workflow or service. */
export interface DiagnosticEvent {
  /** Subsystem the event originated from, e.g. `'dab'`, `'fabric'`, `'static'`. */
  area: string;
  /** Human-readable detail. */
  message: string;
  /**
   * Optional structured payload for richer rendering or debug logs. Callers
   * must keep this free of secrets and EUII/EUPI — it may be surfaced to the
   * user (verbose mode) or written to a debug log.
   */
  data?: Record<string, unknown>;
}

/**
 * Diagnostics adapter — structured verbose / debug detail.
 *
 * Distinct from `Logger` (normal human-facing output) and `Progress` (phase
 * reporting). This is the channel that `--verbose` controls: workflows emit
 * diagnostic events unconditionally, and Layer 1 decides whether to render
 * them. A host may persist events regardless of rendering mode and use
 * `--verbose` only to select an additional stderr or output-channel mirror.
 * Because rendering is host-owned, the flag never reaches the workflow — it
 * only affects which sinks the host composes behind `Diagnostics`.
 *
 * Events are structured (an `area` tag plus an optional `data` payload)
 * rather than preformatted strings, so a host can render them as plain
 * lines, grouped output-channel entries, or structured JSONL in a debug
 * mode without the workflow knowing the difference.
 */
export interface Diagnostics {
  /**
   * Emit a debug-level diagnostic event to the sinks composed by the host.
   * Hosts may always persist events and conditionally mirror them when verbose
   * rendering is enabled.
   */
  debug(event: DiagnosticEvent): void;
}

/** A diagnostics sink that silently discards all events for tests or hosts without a sink. */
export const silentDiagnostics: Diagnostics = {
  debug() {},
};
