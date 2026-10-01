/**
 * `dev` workflow step: prepare the wiring a locally-run frontend needs.
 *
 * Delegates to {@link DevBackendProvider.prepareForLocalFrontend}: the provider
 * reconfigures the backend for local-frontend access (env, allowed origins /
 * CORS, dev auth redirect URIs) and returns the {@link LocalDevWiring} — the
 * environment variables the local runtimes are started with, plus any non-fatal
 * warnings. It never publishes the app itself.
 *
 * Runs *after* the local runtimes are reserved so the already-claimed runtime
 * URLs can be folded into the frontend env by the provider, which stays the
 * single owner of that env shape.
 */
import type { Step } from '../../types.js';
import type {
  DevBackendProvider,
  DevTarget,
  LocalDevWiring,
} from '../providers/index.js';

/** Inputs for {@link prepareLocalWiring}. */
export interface PrepareLocalWiringInput {
  /** The resolved backend target. */
  target: DevTarget;
  /** Base URLs of the reserved local runtimes, keyed by runtime id. */
  runtimeUrls?: Record<string, string>;
}

/** Capabilities {@link prepareLocalWiring} composes. */
export interface PrepareLocalWiringDeps {
  backend: DevBackendProvider;
}

/**
 * Prepare local-frontend wiring against the backend.
 *
 * @throws When the provider cannot reconfigure the backend for local access.
 *   Non-fatal issues are returned as {@link LocalDevWiring.warnings} instead.
 */
export const prepareLocalWiring: Step<
  PrepareLocalWiringInput,
  LocalDevWiring,
  PrepareLocalWiringDeps
> = async ({ target, runtimeUrls }, { backend }) =>
  backend.prepareForLocalFrontend(target, { runtimeUrls });
