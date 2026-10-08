/**
 * The `dev` backend-provider seam (Layer 2 strategy contract).
 *
 * `rayfin dev` is the inner loop: *my code* (frontend + functions) always runs
 * locally; `--provider` selects *where the managed Rayfin backend runs*
 * (`fabric` default, `docker` next). A {@link DevBackendProvider} is the
 * strategy that encapsulates a single backend host: it resolves the backend
 * target, makes it ready, applies the project's declared state (schema,
 * storage, connectors) to it, prepares the wiring a locally-run frontend needs,
 * and tears down whatever it owns on Ctrl-C.
 *
 * The provider is selected in Layer 1 from `--provider` and injected into the
 * workflow as `deps.backend`. The workflow **never branches on the provider
 * id** — the step list is identical across providers; only the injected
 * strategy differs. The shared shapes here carry **no** backend-specific nouns
 * (no Fabric workspace/item, no Docker compose), so a second provider is added
 * as a peer rather than by generalizing the first.
 *
 * See docs/rfc/rfc-cli-dev-inner-loop.md and
 * docs/rfc/rayfin-tools-architecture.md ("Providers (the run-target seam)").
 */
import type { ConnectorEntry, RayfinConfig } from '../../../config/index.js';

/**
 * Neutral inputs a provider needs to resolve its backend target.
 *
 * Intentionally minimal and backend-agnostic: host-specific context (an
 * acquired token, a target workspace id, a Docker socket) is supplied to the
 * concrete provider at construction in Layer 1, not threaded through here.
 */
export interface DevProviderRequest {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** The loaded `rayfin.yml` configuration. */
  config: RayfinConfig;
}

/**
 * A resolved backend target, threaded from {@link DevBackendProvider.resolveTarget}
 * through every subsequent provider call so each hits the same backend.
 *
 * The shared shape is deliberately neutral — only what the workflow needs to
 * render and what a locally-run frontend needs to reach the backend. A concrete
 * provider extends this with its own resolved coordinates (Fabric endpoints and
 * auth header, a Docker compose project) via the {@link DevBackendProvider}
 * `Target` type parameter; the workflow treats those extra fields as opaque.
 */
export interface DevTarget {
  /**
   * Stable id of the provider that resolved this target (e.g. `'fabric'`).
   * For diagnostics and rendering only — the workflow never branches on it.
   */
  readonly provider: string;
  /** Human-readable backend label for output (e.g. a workspace name, or `'local Docker'`). */
  readonly displayName: string;
  /**
   * Backend API endpoint a locally-run frontend/functions call, when known at
   * resolve time. Absent until {@link DevBackendProvider.ensureReady} for
   * providers that provision lazily.
   */
  readonly apiUrl?: string;
}

/**
 * Outcome of {@link DevBackendProvider.ensureReady}.
 *
 * A provider may provision lazily while making the backend ready, so a ready
 * outcome carries the effective target that every later workflow step must
 * use. A backend that cannot be made ready (for example, a Docker daemon that
 * is not running) is a typed `unavailable` outcome — never a thrown error — so
 * the workflow maps it to a stable `Result.failed` with the provider's
 * remediation message.
 */
export type EnsureBackendReadyOutcome<Target extends DevTarget = DevTarget> =
  | { status: 'ready'; target: Target; warnings?: string[] }
  | { status: 'cancelled' }
  | { status: 'unavailable'; code: string; message: string };

/** Inputs for {@link DevBackendProvider.applyDataConfig}. */
export interface ApplyDataConfigInput {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** The `services.data` block from `rayfin.yml`. */
  data: RayfinConfig['services']['data'];
}

/** Inputs for {@link DevBackendProvider.applyStorageConfig}. */
export interface ApplyStorageConfigInput {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** The `services.storage` block from `rayfin.yml`. */
  storage: NonNullable<RayfinConfig['services']['storage']>;
}

/**
 * Wiring a locally-run frontend (and functions) needs to reach the selected
 * backend: environment variables to inject into the local runtimes, plus any
 * non-fatal warnings raised while preparing it (e.g. a redirect-URI allow-list
 * append that failed but should not block the session).
 *
 * Backend-neutral: for Fabric this is the remote endpoint / publishable key and
 * a refreshed allow-list; for Docker it is the local container URLs. The
 * workflow forwards `env` to the runtimes without inspecting keys.
 */
export interface LocalDevWiring {
  /** Environment variables to inject into the local frontend + functions runtimes. */
  env: Record<string, string>;
  /** Non-fatal warnings surfaced while preparing local wiring. */
  warnings?: string[];
}

/** Options for {@link DevBackendProvider.prepareForLocalFrontend}. */
export interface PrepareLocalFrontendOptions {
  /**
   * Base URLs of the local runtimes reserved for this session, keyed by runtime
   * id (e.g. `{ functions: 'http://localhost:7071' }`). The workflow forwards
   * the map without interpreting it; each provider decides which entries belong
   * in the frontend env, so the backend stays the single owner of that shape.
   */
  runtimeUrls?: Record<string, string>;
}

/** Options for {@link DevBackendProvider.teardown}. */
export interface TeardownOptions {
  /**
   * Also purge provider-owned local state (e.g. Docker data volumes) rather
   * than just stopping. A no-op for providers with nothing durable to purge.
   */
  purge?: boolean;
}

/**
 * A `dev` backend strategy: one implementation per backend host.
 *
 * Generic over its resolved {@link DevTarget} so a concrete provider can thread
 * its own coordinates through the pipeline while the workflow depends only on
 * the neutral base type. Method parameters are covariant-by-convention here:
 * the target passed to every call is a value the provider itself produced
 * (from `resolveTarget` or `ensureReady`), so reading the provider's extended
 * fields is sound at runtime even though the workflow holds the base type.
 *
 * Contract: every method rejects on unexpected failure and the workflow
 * entrypoint maps the rejection to a `Result.failed`. Expected, actionable
 * conditions are typed return values instead (e.g.
 * {@link EnsureBackendReadyOutcome}). No method calls `process.exit`, prints
 * output, or imports host built-ins.
 */
export interface DevBackendProvider<Target extends DevTarget = DevTarget> {
  /** Resolve the backend target coordinates for this run. */
  resolveTarget(request: DevProviderRequest): Promise<Target>;

  /**
   * Make the backend ready to serve the local inner loop and return the
   * effective target. Providers may replace the resolved target when readiness
   * requires lazy provisioning; Docker brings up compose in place.
   */
  ensureReady(target: Target): Promise<EnsureBackendReadyOutcome<Target>>;

  /**
   * Apply the project's declared database schema to the backend. A project
   * with no entities is a no-op. Called only when `services.data` is enabled.
   */
  applyDataConfig(target: Target, input: ApplyDataConfigInput): Promise<void>;

  /**
   * Apply the project's declared storage configuration to the backend. Called
   * only when `services.storage` is enabled.
   */
  applyStorageConfig(
    target: Target,
    input: ApplyStorageConfigInput
  ): Promise<void>;

  /**
   * Sync the project's declared services and connectors to the backend before
   * schema/storage apply. Connectors are always remote — they front external
   * services and have no local implementation — so this targets the remote
   * regardless of provider. An empty or absent connectors block is a no-op.
   */
  syncConnectors(
    target: Target,
    connectors: ConnectorEntry[] | undefined
  ): Promise<void>;

  /**
   * Reconfigure the backend for local-frontend access (env, allowed
   * origins / CORS, dev auth redirect URIs) and return the wiring the local
   * runtimes need. Never publishes the app itself.
   *
   * `options.runtimeUrls` carries the ports already reserved for this session,
   * so the returned env can point the frontend at a sibling local runtime.
   */
  prepareForLocalFrontend(
    target: Target,
    options?: PrepareLocalFrontendOptions
  ): Promise<LocalDevWiring>;

  /**
   * Tear down whatever this provider owns for the session (Docker stops its
   * containers; Fabric is a no-op). Best-effort: invoked from the workflow's
   * cleanup path on Ctrl-C or normal end.
   */
  teardown(target: Target, options: TeardownOptions): Promise<void>;
}
