/**
 * Request, result, and dependency contracts for the `dev` workflow.
 *
 * `DevRequest` is the normalized product intent Layer 1 hands to the workflow —
 * the selected provider id and the loaded config, but no raw Commander options,
 * `OutputMode`, or TTY booleans. `DevResult` is the structured outcome Layer 1
 * renders. `DevDeps` is the per-workflow capability slice each host satisfies:
 * the injected backend strategy, the local-runtime provisioner, a command
 * runner, and push-style progress.
 *
 * See docs/rfc/rfc-cli-dev-inner-loop.md and
 * docs/rfc/rayfin-tools-architecture.md ("Workflow signature & Deps").
 */
import type {
  CancellationToken,
  CommandRunner,
  Diagnostics,
  Progress,
} from '../../adapters/index.js';
import type { RayfinConfig } from '../../config/index.js';

import type { DevBackendProvider } from './providers/index.js';
import type { LocalRuntimeProvisioner } from './runtimes.js';

/** Normalized product intent for a `rayfin dev` invocation. */
export interface DevRequest {
  /** The loaded `rayfin.yml` configuration. */
  config: RayfinConfig;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /**
   * Selected backend provider id (`fabric` default, `docker` next), resolved
   * in Layer 1 from `--provider`. Carried for rendering and the result summary;
   * the workflow never branches on it (the injected `deps.backend` does the
   * work).
   */
  provider: string;
  /**
   * Purge provider-owned local state on teardown (`--purge`). Forwarded to the
   * provider's {@link DevBackendProvider.teardown}; a no-op for providers with
   * nothing durable to purge (e.g. Fabric).
   */
  purge?: boolean;
  /** Skip applying data configuration to the selected backend. */
  skipDataApply?: boolean;
}

/** Structured outcome of a `dev` session. */
export interface DevResult {
  /** Selected backend provider id. */
  provider: string;
  /** Resolved backend target, narrowed to what Layer 1 renders. */
  target: {
    /** Human-readable backend label. */
    displayName: string;
    /** Backend API endpoint the local frontend reached, when known. */
    apiUrl?: string;
  };
  /** Ids of the local runtimes that launched during the session. */
  startedRuntimes: string[];
  /** Reserved base URLs keyed by runtime id. */
  runtimeUrls: Record<string, string>;
  /** Non-fatal warnings aggregated across the session. */
  warnings: string[];
}

/** Capability slice the `dev` workflow composes. */
export interface DevDeps {
  diagnostics: Diagnostics;
  /**
   * The selected backend strategy, injected by Layer 1 from `--provider`. The
   * workflow drives the pipeline entirely through this and never inspects which
   * concrete provider it is.
   */
  backend: DevBackendProvider;
  /**
   * Host strategy that reserves and prepares the local runtimes (frontend +
   * functions) this session runs. Injected by Layer 1, which knows what the
   * host can start.
   */
  runtimes: LocalRuntimeProvisioner;
  /** Runs and keeps alive the local frontend / functions runtimes. */
  runner: CommandRunner;
  /** Push-style progress reporting; rendered (or silenced) by the host. */
  progress: Progress;
  /**
   * Cooperative cancellation honored between steps and forwarded to the local
   * runtimes. Ctrl-C flips this; the workflow then tears the backend down.
   */
  signal?: CancellationToken;
}
