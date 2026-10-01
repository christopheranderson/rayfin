/**
 * CLI implementation of the {@link FrameworkEnvService} product-service
 * contract.
 *
 * A thin delegation to the existing `detectFrontendFramework` (config-file and
 * dependency sniffing) and `writeFrameworkEnvFile` (the `rayfin env` writer).
 * The contract is async so an asynchronous host can satisfy it; the CLI host
 * wraps the synchronous detector.
 */
import type {
  FrontendFramework,
  StaticHostingConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import type {
  FrameworkEnvService,
  WriteFrameworkEnvRequest,
} from '@microsoft/rayfin-tools-common/_internal/services/framework-env';

import { writeFrameworkEnvFile } from '../commands/env/env.js';
import {
  resolveServiceRoot,
  resolveServiceSubpath,
} from '../utils/config-utils.js';
import { detectFrontendFramework } from '../utils/frontend-detect.js';

function frontendRoot(
  projectRoot: string,
  staticHosting?: StaticHostingConfig
): string {
  if (!staticHosting) return projectRoot;
  return resolveServiceSubpath(
    resolveServiceRoot(projectRoot, 'staticHosting', staticHosting.path ?? '.'),
    'staticHosting',
    'root',
    staticHosting.root || '.'
  );
}

/** Construct the CLI-host {@link FrameworkEnvService}. */
export function createCliFrameworkEnvService(): FrameworkEnvService {
  return {
    // `async` (rather than `Promise.resolve(...)`) so a synchronous throw from
    // the detector's filesystem reads surfaces as a rejection.
    async detectFramework(
      projectRoot: string,
      staticHosting?: StaticHostingConfig
    ): Promise<string | null> {
      return detectFrontendFramework(frontendRoot(projectRoot, staticHosting));
    },

    writeEnvFile(request: WriteFrameworkEnvRequest): Promise<string> {
      return writeFrameworkEnvFile({
        projectRoot: request.projectRoot,
        // The universal contract types `framework` as a plain string; the value
        // originates from `detectFramework` above (a `FrontendFramework`), so
        // narrowing here is safe.
        framework: request.framework as FrontendFramework,
        outputDir:
          request.outputDir ??
          (request.staticHosting
            ? frontendRoot(request.projectRoot, request.staticHosting)
            : '.'),
      });
    },
  };
}
