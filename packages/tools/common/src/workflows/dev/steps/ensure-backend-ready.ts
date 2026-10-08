/**
 * `dev` workflow step: ensure the resolved backend is ready to serve.
 *
 * Delegates to {@link DevBackendProvider.ensureReady}. A backend that cannot be
 * made ready (for example, a Docker daemon that isn't running or Fabric item
 * reuse that needs consent) is a typed {@link EnsureBackendReadyOutcome} of
 * `unavailable` — never a throw — so the workflow maps it to a stable
 * `Result.failed` carrying the provider's remediation message.
 */
import type { Step } from '../../types.js';
import type {
  DevBackendProvider,
  DevTarget,
  EnsureBackendReadyOutcome,
} from '../providers/index.js';

/** Inputs for {@link ensureBackendReady}. */
export interface EnsureBackendReadyInput {
  /** The resolved backend target. */
  target: DevTarget;
}

/** Capabilities {@link ensureBackendReady} composes. */
export interface EnsureBackendReadyDeps {
  backend: DevBackendProvider;
}

/**
 * Make the backend ready.
 *
 * @throws On an unexpected provider failure. An expected "backend not
 *   available yet" condition is returned as `unavailable`, not thrown.
 */
export const ensureBackendReady: Step<
  EnsureBackendReadyInput,
  EnsureBackendReadyOutcome,
  EnsureBackendReadyDeps
> = async ({ target }, { backend }) => backend.ensureReady(target);
