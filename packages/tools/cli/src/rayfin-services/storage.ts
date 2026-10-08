/**
 * CLI implementation of the {@link StorageService} product-service contract.
 *
 * Delegates to the existing `generateStorageConfig` and
 * `applyStorageConfigToServer` utils. The universal request (product intent)
 * is mapped onto the util's options; CLI-only concerns (output mode, verbose,
 * exit-on-error) are not exposed by the contract.
 */
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type {
  ApplyStorageConfigRequest,
  StorageService,
} from '@microsoft/rayfin-tools-common/_internal/services/storage';

import { applyStorageConfigToServer } from '../utils/storage-apply.js';
import { generateStorageConfig } from '../utils/storage-config-generator.js';

/**
 * Construct the CLI-host {@link StorageService}.
 */
export function createCliStorageService(
  options: {
    diagnostics?: Diagnostics;
    verbose?: boolean;
  } = {}
): StorageService {
  return {
    async applyStorageConfig(
      request: ApplyStorageConfigRequest
    ): Promise<void> {
      const result = await generateStorageConfig({
        projectRoot: request.projectRoot,
        verbose: options.verbose,
        mode: 'silent',
        diagnostics: options.diagnostics,
      });

      const endpoint = `${request.target.itemEndpoint}/__private/applystorageconfig`;

      await applyStorageConfigToServer(
        result.configPath,
        endpoint,
        request.force ?? false,
        true,
        request.target.authorizationHeader,
        {
          mode: 'silent',
          diagnostics: options.diagnostics,
        }
      );
    },
  };
}
