/**
 * CLI implementation of the {@link DataService} product-service contract.
 *
 * A thin delegation to the existing `applyDbConfig` util, which generates the
 * DAB configuration from the project's entity decorators and applies it to the
 * local dev server or the deployed remote workload. The universal request
 * (product intent) is mapped onto the util's options; CLI-only concerns
 * (output mode, verbose, exit-on-error) are not exposed by the contract.
 *
 * `propagateError: true` is fixed so failures surface as rejections for the
 * caller (Layer 1 / the workflow) to render, rather than the util printing and
 * swallowing them.
 */
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type {
  ApplyDatabaseConfigRequest,
  DataService,
} from '@microsoft/rayfin-tools-common/_internal/services/data';

import { applyDbConfig } from '../utils/apply-db-config.js';
import { resolveServiceRoot } from '../utils/config-utils.js';

/**
 * Construct the CLI-host {@link DataService}.
 *
 * The host selects capture explicitly so installing a diagnostic sink does
 * not change the build or compiler's terminal policy.
 */
export function createCliDataService(
  options: {
    diagnostics?: Diagnostics;
    captureOutput?: boolean;
  } = {}
): DataService {
  const retryVerbose = (...args: unknown[]): void =>
    options.diagnostics?.debug({
      area: 'data.retry',
      message: args.map(String).join(' '),
    });
  return {
    async applyDatabaseConfig(
      request: ApplyDatabaseConfigRequest
    ): Promise<void> {
      // Resolve `services.data.path` to an absolute entity-source root for
      // multi-package projects, relative to the request's project root.
      const serviceRoot = request.servicePath
        ? resolveServiceRoot(request.projectRoot, 'data', request.servicePath)
        : request.projectRoot;
      const dialect = request.dialect ?? 'mssql';
      await applyDbConfig({
        remote: request.target === 'remote',
        force: request.force,
        dialect,
        projectRoot: request.projectRoot,
        mode: 'silent',
        diagnostics: options.diagnostics,
        buildOutput: options.captureOutput ? 'capture' : 'on-failure',
        compileMode: options.captureOutput ? 'silent' : undefined,
        remoteEndpoint: request.remoteEndpoint,
        // Reuse the header resolved upstream (from the workload target) instead
        // of reacquiring auth — so the token `rayfin up` already acquired with
        // the user's `--tenant` / `--encryption-fallback-enabled` is honored.
        authorizationHeader: request.authorizationHeader,
        // During `rayfin up` the apply runs before the deployment is recorded,
        // so the moniker must come from the request, not the registry fallback.
        rayfinItemId: request.itemId,
        serviceRoot,
        buildCommand: request.buildCommand,
        retryTransientErrors: request.retryTransientErrors,
        retryOptions: { verbose: retryVerbose },
        propagateError: true,
      });
    },
  };
}
