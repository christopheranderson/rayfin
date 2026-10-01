/**
 * `dev` workflow step: apply the project's declared backend state.
 *
 * Hydrates *your services* with *my declared state* — the schema and storage
 * config from local code are applied to the selected backend. Data and storage
 * are gated independently on their `services.*.enabled` flags; each is a thin
 * delegation to the provider so the same step drives Fabric (remote apply) and
 * Docker (local apply) without branching on the backend.
 *
 * This never publishes the app itself (static bundle, deployed functions) —
 * that stays `rayfin up`.
 */
import type { RayfinConfig } from '../../../config/index.js';
import type { Step } from '../../types.js';
import type { DevBackendProvider, DevTarget } from '../providers/index.js';

/** Inputs for {@link applyDeclaredState}. */
export interface ApplyDeclaredStateInput {
  /** The resolved backend target. */
  target: DevTarget;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** The `services` block from `rayfin.yml`. */
  services: RayfinConfig['services'];
  /** Skip applying data configuration while preserving other declared state. */
  skipDataApply?: boolean;
}

/** Capabilities {@link applyDeclaredState} composes. */
export interface ApplyDeclaredStateDeps {
  backend: DevBackendProvider;
}

/** Which declared-state facets were applied. */
export interface ApplyDeclaredStateResult {
  appliedData: boolean;
  appliedStorage: boolean;
}

/**
 * Apply declared schema and storage to the backend.
 *
 * @throws When the provider's apply rejects. The workflow entrypoint maps the
 *   rejection to a `Result.failed`.
 */
export const applyDeclaredState: Step<
  ApplyDeclaredStateInput,
  ApplyDeclaredStateResult,
  ApplyDeclaredStateDeps
> = async ({ target, projectRoot, services, skipDataApply }, { backend }) => {
  let appliedData = false;
  let appliedStorage = false;

  if (services.data?.enabled && !skipDataApply) {
    await backend.applyDataConfig(target, { projectRoot, data: services.data });
    appliedData = true;
  }

  if (services.storage?.enabled) {
    await backend.applyStorageConfig(target, {
      projectRoot,
      storage: services.storage,
    });
    appliedStorage = true;
  }

  return { appliedData, appliedStorage };
};
