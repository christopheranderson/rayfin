/**
 * Back-compat re-export shim for the environment-configuration model.
 *
 * @deprecated The shared environment-config model moved to
 * `@microsoft/rayfin-tools-common/_internal/env-config` as part of the
 * tools architecture migration (the rename frees `services/auth/` for the
 * Rayfin auth product service; see
 * docs/rfc/rayfin-tools-architecture-migration.md). This module re-exports
 * the relocated symbols so existing `_internal/auth` imports keep working;
 * import from the `_internal/env-config` subpath directly in new code.
 *
 * Mirrors the universal-vs-Node-only split of the real module: the types
 * and metadata are universal, while {@link bootstrapEnvironmentConfig} is
 * Node-only and must only be invoked from Node entry points (CLI /
 * `create-rayfin`).
 */
export type {
  EnvironmentConfig,
  EnvironmentConfigField,
  EnvironmentConfigGroup,
} from '../env-config/index.js';
export { RAYFIN_ENV_CONFIG_VARS } from '../env-config/index.js';
export { bootstrapEnvironmentConfig } from '../env-config/index.js';
