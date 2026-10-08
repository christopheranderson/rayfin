/**
 * `up` workflow step: apply runtime (service) settings to the deployed item.
 *
 * Validates the `connectors` block locally **before** any network call so
 * Builders get actionable errors (unknown type, bad version, …) at `rayfin up`
 * time rather than a cryptic server-side rejection. Validation failure is
 * returned as a typed outcome ({@link ApplyRuntimeSettingsResult}) — never a
 * thrown handled error — so the workflow entrypoint maps it to a stable
 * `Result.failed` code.
 *
 * On success the runtime settings are pushed through the {@link RayfinWorkloadClient}
 * seam, which merges a non-empty `connectors` block as a sibling of the
 * service keys (the carry-forward from #1470). This is the *initial* apply; the
 * post-deploy redirect-URI patch is a separate send from `persist-hosting-url`.
 */
import {
  type ConnectorValidationError,
  type FunctionsConfigValidationError,
  type RayfinConfig,
  validateConnectors,
  validateFunctionsConfig,
} from '../../../config/index.js';
import type {
  RayfinWorkloadClient,
  WorkloadTarget,
} from '../../../external/fabric/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link applyRuntimeSettings}. */
export interface ApplyRuntimeSettingsInput {
  /** Resolved workload coordinates for the deployed item. */
  target: WorkloadTarget;
  /** The `services` block from `rayfin.yml`. */
  services: RayfinConfig['services'];
  /** The `connectors` block from `rayfin.yml`, validated then forwarded. */
  connectors?: RayfinConfig['connectors'];
  /** Versions of the Rayfin packages this deploy ships, declared on the wire. */
  packageVersions?: Record<string, string>;
}

/** Outcome of {@link applyRuntimeSettings}. */
export type ApplyRuntimeSettingsResult =
  | { status: 'applied' }
  | {
      /** The `connectors` block failed local validation; nothing was sent. */
      status: 'invalid-connectors';
      errors: ConnectorValidationError[];
    }
  | {
      /** The functions block failed local validation; nothing was sent. */
      status: 'invalid-functions-config';
      errors: FunctionsConfigValidationError[];
    };

/** Capabilities {@link applyRuntimeSettings} composes. */
export interface ApplyRuntimeSettingsDeps {
  workload: RayfinWorkloadClient;
}

/**
 * Validate connectors and the functions block, then apply runtime settings to
 * the deployed item.
 *
 * @throws When the workload rejects the settings POST after the host's retry
 *   policy is exhausted. Declined-by-validation blocks are not throws — they
 *   are returned as `invalid-connectors` or `invalid-functions-config`.
 */
export const applyRuntimeSettings: Step<
  ApplyRuntimeSettingsInput,
  ApplyRuntimeSettingsResult,
  ApplyRuntimeSettingsDeps
> = async (input, { workload }) => {
  const errors = validateConnectors(input.connectors);
  if (errors.length > 0) {
    return { status: 'invalid-connectors', errors };
  }

  const functionsErrors = validateFunctionsConfig(input.services.functions);
  if (functionsErrors.length > 0) {
    return { status: 'invalid-functions-config', errors: functionsErrors };
  }

  await workload.applyRuntimeSettings(input.target, {
    services: input.services,
    connectors: input.connectors,
    packageVersions: input.packageVersions,
    label: 'runtime-settings',
  });

  return { status: 'applied' };
};
