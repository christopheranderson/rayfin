/**
 * CLI implementation of the {@link FunctionsService} product-service contract.
 *
 * A thin delegation to the existing `deployFunctions` orchestrator. The deploy
 * URL, item id (moniker), and authorization header are resolved upstream from
 * the workload target and passed in; this impl only resolves the functions
 * service root from `services.functions.path` and runs the build/package/deploy
 * sequence. CLI-only concerns (progress rendering, verbose) are not exposed by
 * the contract — the workflow step owns progress via its adapters.
 *
 * `skipBuild: false` / `isCompiledZip: true` mirror the legacy `rayfin up`
 * call: the user build runs, then the compiled output is shipped without a
 * remote rebuild.
 */
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type {
  DeployFunctionsRequest,
  FunctionsService,
} from '@microsoft/rayfin-tools-common/_internal/services/functions';

import { deployFunctions } from '../commands/up/up-functions.js';
import { resolveServiceRoot } from '../utils/config-utils.js';

/** Construct the CLI-host {@link FunctionsService}. */
export function createCliFunctionsService(
  options: { diagnostics?: Diagnostics; captureOutput?: boolean } = {}
): FunctionsService {
  return {
    async deploy(request: DeployFunctionsRequest): Promise<void> {
      const serviceRoot = resolveServiceRoot(
        request.projectRoot,
        'functions',
        request.config.path ?? 'rayfin/functions'
      );
      await deployFunctions({
        serviceRoot,
        deployUrl: request.deployUrl,
        rayfinItemId: request.itemId,
        authorizationHeader: request.authorizationHeader,
        functionsConfig: request.config,
        skipBuild: false,
        isCompiledZip: true,
        diagnostics: options.diagnostics,
        mode: options.captureOutput ? 'silent' : undefined,
        buildOutput: options.captureOutput ? 'capture' : 'inherit',
      });
    },
  };
}
