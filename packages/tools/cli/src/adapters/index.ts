/**
 * CLI host implementations of the tools-common adapter interfaces.
 *
 * One real implementation per adapter, shared across all CLI commands (per
 * RFC: per-command adapter impls are an anti-pattern). Layer 1
 * (`cli/src/index.ts`) constructs the host container from these and supplies
 * each workflow the `Deps` slice it declares.
 *
 * Adapters whose impl depends on resolved rendering mode or runtime wiring
 * are exposed as factories (`createOraProgress`, `createCliHttp`) rather than
 * singletons; the rest are stateless singletons.
 *
 * `Diagnostics` and `CancellationToken` have no CLI-specific impl yet — the
 * shared `silentDiagnostics` / `noopCancellationToken` (or an `AbortSignal`
 * adapter) suffice until a workflow needs more. They are intentionally absent
 * here.
 */
export { cliAuth } from './auth.js';
export { cliFs } from './fs.js';
export { createCliHttp } from './http.js';
export { cliLogger } from './logger.js';
export {
  createOraProgress,
  plainProgress,
  silentProgress,
} from './progress.js';
export { cliCommandRunner } from './runner.js';
export { cliSecretStore } from './secrets.js';
export { CliTelemetryHandle } from './telemetry.js';
export { cliUserInteraction } from './user-interaction.js';
