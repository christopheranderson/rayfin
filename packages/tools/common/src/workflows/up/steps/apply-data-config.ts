/**
 * `up` workflow step: apply the database configuration to the deployed workload.
 *
 * Delegates generation + remote apply to the {@link DataService} (targeting the
 * item's workload endpoint). Any failure is fatal because continuing would
 * publish an application whose configured data API is unavailable.
 */
import type { RayfinConfig } from '../../../config/index.js';
import type { WorkloadTarget } from '../../../external/fabric/index.js';
import type { DataService } from '../../../services/data/index.js';
import { HttpError } from '../../../utils/retry/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link applyDataConfig}. */
export interface ApplyDataConfigInput {
  /** Resolved workload coordinates for the deployed item. */
  target: WorkloadTarget;
  /** The `services.data` block from `rayfin.yml`. */
  dataConfig: RayfinConfig['services']['data'];
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Allow destructive schema changes (`--force`). */
  force?: boolean;
}

/** Capabilities {@link applyDataConfig} composes. */
export interface ApplyDataConfigDeps {
  data: DataService;
}

/**
 * Apply the DAB configuration to the remote workload.
 *
 * @throws When configuration generation or remote apply fails.
 */
export const applyDataConfig: Step<
  ApplyDataConfigInput,
  void,
  ApplyDataConfigDeps
> = async (input, { data }) => {
  try {
    await data.applyDatabaseConfig({
      projectRoot: input.projectRoot,
      target: 'remote',
      force: input.force,
      dialect: input.dataConfig.dialect,
      remoteEndpoint: input.target.itemEndpoint,
      authorizationHeader: input.target.authorizationHeader,
      itemId: input.target.itemId,
      servicePath: input.dataConfig.path,
      buildCommand: input.dataConfig.buildCommand,
      retryTransientErrors: true,
    });
  } catch (error) {
    throw addUpDataApplyErrorContext(error, input.dataConfig.dialect);
  }
};

function addUpDataApplyErrorContext(
  error: unknown,
  dialect: RayfinConfig['services']['data']['dialect']
): unknown {
  if (
    (dialect ?? 'mssql') !== 'mssql' ||
    !(error instanceof HttpError) ||
    error.statusCode !== 500
  ) {
    return error;
  }

  return new HttpError(
    'Fabric SQL Database could not be configured in this workspace.\n' +
      '   The service returned an internal error after retrying.\n' +
      '   Run `rayfin up` again in a few minutes.\n' +
      '   If it still fails, workspace-level private links may be the cause.\n' +
      '   Fabric SQL Database does not support workspace-level private links.\n' +
      '   If this workspace uses them, use a different workspace or disable data in `rayfin.yml`.\n' +
      '   Otherwise, contact support with the response and any request ID below.\n' +
      `   Server response: ${error.message}`,
    error.statusCode,
    error.retryAfterMs,
    { cause: error }
  );
}
