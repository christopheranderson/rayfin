/**
 * `dev` workflow step: resolve the backend target through the injected provider.
 *
 * A thin delegation to {@link DevBackendProvider.resolveTarget} — the provider
 * owns endpoint/coordinate resolution; the step exists so the workflow reads as
 * a table of contents and so cancellation is checked at a step boundary before
 * the (potentially networked) resolve.
 */
import type { Step } from '../../types.js';
import type {
  DevBackendProvider,
  DevProviderRequest,
  DevTarget,
} from '../providers/index.js';

/** Capabilities {@link resolveTarget} composes. */
export interface ResolveTargetDeps {
  backend: DevBackendProvider;
}

/**
 * Resolve the backend {@link DevTarget} for this run.
 *
 * @throws When the provider cannot resolve its coordinates. The workflow
 *   entrypoint maps the rejection to a `Result.failed`.
 */
export const resolveTarget: Step<
  DevProviderRequest,
  DevTarget,
  ResolveTargetDeps
> = async (input, { backend }) => backend.resolveTarget(input);
