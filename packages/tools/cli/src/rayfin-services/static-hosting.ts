/**
 * CLI implementation of the {@link StaticHostingService} product-service
 * contract.
 *
 * Each method is a thin delegation to an existing static-hosting util; the
 * orchestration (validate → build → package → deploy → persist) belongs to the
 * workflow, not here. Binary payloads cross the universal boundary as
 * `Uint8Array`; the deploy delegation bridges to the util's `Buffer` parameter.
 */
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { StaticHostingConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type {
  PersistAssetAccessResult,
  PersistHostingUrlRequest,
  PersistHostingUrlResult,
  StaticDeployResult,
  StaticFolderValidation,
  StaticHostingService,
} from '@microsoft/rayfin-tools-common/_internal/services/static-hosting';

import {
  resolveServiceRoot,
  writeRayfinConfigUpdates,
} from '../utils/config-utils.js';
import { persistHostingUrlState } from '../utils/hosting-url-utils.js';
import {
  deployStaticContent,
  packageStaticFolder,
  runStaticBuildCommand,
  validateStaticFolder,
} from '../utils/static-hosting-utils.js';

/**
 * Construct the CLI-host {@link StaticHostingService}.
 *
 * Build capture is selected by the host independently of diagnostic sinks.
 */
export function createCliStaticHostingService(
  options: {
    diagnostics?: Diagnostics;
    captureOutput?: boolean;
  } = {}
): StaticHostingService {
  return {
    // `async` (rather than `Promise.resolve(validateStaticFolder(...))`) so a
    // synchronous throw from the util's un-guarded directory walk surfaces as a
    // rejection, not an exception at the call site that a `.catch()` would miss.
    async validateFolder(
      projectRoot: string,
      config: StaticHostingConfig
    ): Promise<StaticFolderValidation> {
      return validateStaticFolder(
        resolveServiceRoot(projectRoot, 'staticHosting', config.path ?? '.'),
        config
      );
    },

    runBuild(
      projectRoot: string,
      config: StaticHostingConfig
    ): Promise<boolean> {
      return runStaticBuildCommand(
        resolveServiceRoot(projectRoot, 'staticHosting', config.path ?? '.'),
        config,
        {
          output: options.captureOutput ? 'capture' : 'on-failure',
          diagnostics: options.diagnostics,
        }
      );
    },

    async packageFolder(resolvedStaticDir: string): Promise<Uint8Array> {
      return packageStaticFolder(resolvedStaticDir);
    },

    deploy(
      pkg: Uint8Array,
      endpoint: string,
      authorizationHeader: string,
      extraHeaders?: Record<string, string>
    ): Promise<StaticDeployResult> {
      return deployStaticContent(
        Buffer.from(pkg),
        endpoint,
        authorizationHeader,
        extraHeaders,
        options.diagnostics
      );
    },

    persistHostingUrl(
      request: PersistHostingUrlRequest
    ): Promise<PersistHostingUrlResult> {
      return persistHostingUrlState(request);
    },

    async persistAssetAccess(request: {
      projectRoot: string;
      assetAccess: NonNullable<StaticHostingConfig['assetAccess']>;
    }): Promise<PersistAssetAccessResult> {
      const updates = {
        services: {
          staticHosting: { assetAccess: request.assetAccess },
        },
      };

      const result = writeRayfinConfigUpdates(
        updates as unknown as Parameters<typeof writeRayfinConfigUpdates>[0],
        request.projectRoot,
        {
          removePaths: [['services', 'staticHosting', 'anonymousAccess']],
        }
      );

      return result.status === 'failed'
        ? { status: 'failed', error: result.error }
        : { status: 'persisted' };
    },
  };
}
