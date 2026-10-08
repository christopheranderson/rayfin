/**
 * `dev` workflow step: sync the project's declared connectors to the backend.
 *
 * Connectors are always remote — they front external services (databases, SaaS
 * APIs) and have no local implementation — so this runs on every invocation
 * regardless of provider. Mirrors the `up` workflow: the connectors block is
 * validated locally **before** any network call so Builders get actionable
 * errors (unknown type, bad version, …) at `rayfin dev` time rather than a
 * cryptic server-side rejection. Validation failure is a typed outcome — never
 * a throw — so the entrypoint maps it to a stable `Result.failed`.
 */
import {
  type ConnectorValidationError,
  type RayfinConfig,
  validateConnectors,
} from '../../../config/index.js';
import type { Step } from '../../types.js';
import type { DevBackendProvider, DevTarget } from '../providers/index.js';

/** Inputs for {@link syncConnectors}. */
export interface SyncConnectorsInput {
  /** The resolved backend target. */
  target: DevTarget;
  /** The `connectors` block from `rayfin.yml`, validated then synced. */
  connectors?: RayfinConfig['connectors'];
}

/** Capabilities {@link syncConnectors} composes. */
export interface SyncConnectorsDeps {
  backend: DevBackendProvider;
}

/** Outcome of {@link syncConnectors}. */
export type SyncConnectorsResult =
  | { status: 'synced' }
  | {
      /** The `connectors` block failed local validation; nothing was synced. */
      status: 'invalid-connectors';
      errors: ConnectorValidationError[];
    };

/**
 * Validate connectors, then sync them to the backend.
 *
 * @throws When the backend rejects the sync. A declined-by-validation
 *   `connectors` block is not a throw — it is returned as `invalid-connectors`.
 */
export const syncConnectors: Step<
  SyncConnectorsInput,
  SyncConnectorsResult,
  SyncConnectorsDeps
> = async ({ target, connectors }, { backend }) => {
  const errors = validateConnectors(connectors);
  if (errors.length > 0) {
    return { status: 'invalid-connectors', errors };
  }

  await backend.syncConnectors(target, connectors);
  return { status: 'synced' };
};
