/**
 * CLI implementation of the {@link RuntimeConfigService} product-service
 * contract.
 *
 * Resolves the static-hosting `public/` directory the same way
 * `createCliStaticHostingService` resolves its build/validate root (via
 * `resolveServiceRoot` for `config.path` in multi-package layouts, then
 * `config.root` for the frontend project root within it — the same
 * convention Vite/CRA use to copy `public/` into the build output), then
 * delegates the actual write/remove to the existing filesystem util.
 */
import type { StaticHostingConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type {
  RuntimeConfigService,
  RuntimeConfigValues,
  WriteRuntimeConfigResult,
} from '@microsoft/rayfin-tools-common/_internal/services/runtime-config';

import {
  resolveServiceRoot,
  resolveServiceSubpath,
} from '../utils/config-utils.js';
import {
  removeRuntimeConfigFile,
  writeRuntimeConfigFile,
} from '../utils/runtime-config-file.js';

/** Construct the CLI-host {@link RuntimeConfigService}. */
export function createCliRuntimeConfigService(): RuntimeConfigService {
  return {
    write(
      projectRoot: string,
      config: StaticHostingConfig,
      values: RuntimeConfigValues
    ): Promise<WriteRuntimeConfigResult> {
      const staticRoot = resolveServiceRoot(
        projectRoot,
        'staticHosting',
        config.path ?? '.'
      );
      const buildRoot = resolveServiceSubpath(
        staticRoot,
        'staticHosting',
        'root',
        config.root ?? '.'
      );
      const publicDir = resolveServiceSubpath(
        buildRoot,
        'staticHosting',
        'public directory',
        'public'
      );
      return writeRuntimeConfigFile(publicDir, values);
    },

    remove(path: string | undefined): Promise<void> {
      return removeRuntimeConfigFile(path);
    },
  };
}
