/**
 * Platform-primitive adapter interfaces for the Rayfin tools target
 * architecture.
 *
 * Each adapter is a narrow interface with one real implementation per host
 * (shared across all that host's commands) plus a test fake. Universal
 * workflow and service code declares the adapters it needs in its `Deps`
 * type; the host supplies matching implementations at the call site.
 *
 * See docs/rfc/rayfin-tools-architecture.md ("Adapter primitives") and
 * docs/rfc/rayfin-tools-architecture-migration.md.
 */
export type {
  CancellationAbortSignal,
  CancellationToken,
  LinkedCancellation,
} from './cancellation.js';
export {
  abortSignalFromCancellationToken,
  noopCancellationToken,
  cancellationTokenFromSignal,
  createLinkedCancellation,
} from './cancellation.js';

export type { Logger } from './logger.js';
export { silentLogger } from './logger.js';

export type { Progress, ProgressUpdate } from './progress.js';

export type { Diagnostics, DiagnosticEvent } from './diagnostics.js';
export { silentDiagnostics } from './diagnostics.js';

export type { Fs } from './fs.js';

export type { CommandRunner, RunOptions, RunResult } from './runner.js';

export type { Http } from './http.js';

export type { SecretStore } from './secrets.js';

export type { Auth, AuthToken } from './auth.js';

export type {
  UserInteraction,
  SelectChoice,
  SelectOptions,
} from './user-interaction.js';

export type { TelemetryHandle } from './telemetry.js';
export { noopTelemetryHandle } from './telemetry.js';
