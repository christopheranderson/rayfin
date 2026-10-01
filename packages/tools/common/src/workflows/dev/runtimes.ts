/**
 * The local-runtime seam for `rayfin dev` — how *my code* gets started.
 *
 * `dev` always runs the frontend and (when configured) the functions host
 * locally; only the managed backend moves with `--provider`. Resolving those
 * runtimes needs host capabilities the workflow cannot have — free-port
 * probing, toolchain detection, a build, a type-generation watcher — so it is
 * a `Deps`-injected strategy, exactly like {@link DevBackendProvider}.
 *
 * Provisioning is deliberately **two-phase** because the wiring is circular:
 * the functions host needs backend values (`RAYFIN_API_URL`, publishable key)
 * that only `prepareForLocalFrontend` produces, while the frontend needs the
 * functions URL, which only exists after a port has been reserved. `reserve`
 * runs first and claims ports; the resolved URLs are handed to the backend
 * provider so it stays the single owner of the frontend env shape; `prepare`
 * then materializes the runtime specs from the resulting wiring env.
 *
 * See docs/rfc/rfc-cli-dev-inner-loop.md and
 * docs/rfc/rayfin-tools-architecture.md ("Workflow signature & Deps").
 */
import type { CancellationToken } from '../../adapters/index.js';

/**
 * A local runtime `rayfin dev` starts and keeps alive for the session — the
 * inner-loop constant. Produced by {@link LocalRuntimeProvisioner.prepare};
 * the workflow starts each through the `CommandRunner` adapter and does not
 * care what they are.
 */
export interface LocalRuntimeSpec {
  /** Stable id for rendering and the result summary, e.g. `'frontend'` / `'functions'`. */
  id: string;
  /** Human-readable label, e.g. `'frontend dev server'`. */
  label: string;
  /** Executable to run. */
  command: string;
  /** Arguments passed to {@link LocalRuntimeSpec.command}. */
  args: string[];
  /** Absolute working directory for the runtime. */
  cwd: string;
  /** Attach this runtime directly to the host terminal when available. */
  inheritStdio?: boolean;
  /**
   * Environment for this runtime only, merged over the shared backend wiring
   * env. Lets one runtime carry settings its siblings must not see.
   */
  env?: Record<string, string>;
  /**
   * Whether the session depends on this runtime. A required runtime that never
   * launches, or that exits while the session is still live, fails the workflow
   * and cancels its siblings — so a local-debug session never silently falls
   * through to deployed code.
   */
  required?: boolean;
  /**
   * Release everything preparing this runtime acquired — file watchers, pending
   * probes, temp handles. Invoked exactly once when the session ends, however
   * it ends (success, failure, or Ctrl-C).
   */
  dispose?(): void | Promise<void>;
}

/**
 * Advisory runtime values returned by `reserve` but not yet started.
 *
 * A caller may abandon these before `prepare` when wiring or cancellation ends
 * the workflow. Implementations must therefore not retain open sockets,
 * processes, file locks, or any other resource requiring disposal between the
 * two phases.
 */
export interface LocalRuntimeReservation {
  /** Stable runtime id, e.g. `'frontend'` / `'functions'`. */
  id: string;
  /** Human-readable label. */
  label: string;
  /**
   * Base URL this runtime will serve on once started, when it reserved a port
   * (e.g. `http://localhost:7071`). Absent for runtimes that pick their own
   * port at start time.
   */
  url?: string;
}

/**
 * Outcome of {@link LocalRuntimeProvisioner.reserve}.
 *
 * A host that cannot supply a *configured* runtime — no free port in range,
 * a missing toolchain it may not install unattended — returns a typed
 * `unavailable` outcome the workflow maps to a stable `Result.failed` with the
 * host's remediation message. It never throws for these.
 */
export type ReserveLocalRuntimesResult =
  | {
      status: 'reserved';
      reservations: LocalRuntimeReservation[];
      warnings?: string[];
    }
  | { status: 'unavailable'; code: string; message: string };

/** Inputs for {@link LocalRuntimeProvisioner.prepare}. */
export interface PrepareLocalRuntimesInput {
  /** Backend wiring env produced by `prepareForLocalFrontend`. */
  env: Record<string, string>;
  /** The reservations returned by {@link LocalRuntimeProvisioner.reserve}. */
  reservations: LocalRuntimeReservation[];
  /** Cooperative cancellation for the preparation work (builds, typegen). */
  signal?: CancellationToken;
}

/** Outcome of {@link LocalRuntimeProvisioner.prepare}. */
export type PrepareLocalRuntimesResult =
  | { status: 'prepared'; runtimes: LocalRuntimeSpec[]; warnings?: string[] }
  | { status: 'cancelled' }
  | { status: 'unavailable'; code: string; message: string };

/**
 * Host strategy that turns project configuration into startable local
 * runtimes. Constructed in Layer 1 (the host knows what it can run) and
 * injected as `deps.runtimes`.
 */
export interface LocalRuntimeProvisioner {
  /**
   * Resolve host requirements for every configured runtime (ports, toolchain
   * checks). Runs before backend wiring so reserved URLs can be folded into the
   * frontend env. This method must release probes before returning and cannot
   * retain resources that would need cleanup if the reservation is abandoned.
   */
  reserve(input: {
    signal?: CancellationToken;
  }): Promise<ReserveLocalRuntimesResult>;

  /**
   * Materialize startable specs from the reservations and the backend wiring
   * env — writing local settings, building, and starting watchers as needed.
   * Anything acquired here is released through {@link LocalRuntimeSpec.dispose}.
   */
  prepare(
    input: PrepareLocalRuntimesInput
  ): Promise<PrepareLocalRuntimesResult>;
}
