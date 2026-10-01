// Export all from client.ts
export * from './client';
export { default } from './client';

// Runtime configuration loading
export { RayfinConfigError, resolveRayfinConfig } from './config';
export type { RayfinRuntimeConfig, ResolveRayfinConfigOptions } from './config';

// Re-export types from @microsoft/rayfin-data for convenience
export type { TypedDataClients, EntitySchema } from '@microsoft/rayfin-data';

// Re-export types from @microsoft/rayfin-functions for convenience
export type { FunctionsSchema } from '@microsoft/rayfin-functions';

// Connectors — generally available. `ConnectorsRayfinClient` extends the base
// client with a typed `connectors` surface generated from `ConnectorsSchema`.
// Also reachable from the `/experimental` subpath, which is retained as a
// compatibility alias for apps scaffolded before connectors went GA.
export { ConnectorsRayfinClient } from './experimental/ConnectorsRayfinClient';
export type { ConnectorsRayfinClientConfig } from './experimental/ConnectorsRayfinClient';

// Re-export connector schema types so consumers can declare their
// `ConnectorsSchema` without depending on `@microsoft/rayfin-connectors`
// directly.
export type {
  ConnectorConfig,
  ConnectorMarker,
  ConnectorsSchema,
  OperationCatalog,
  OperationDef,
  TypedConnectorsApi,
  TypedConnectorClient,
} from '@microsoft/rayfin-connectors';

// Re-export common types for convenience
export type { ApiClientConfig } from '@microsoft/rayfin-lib';

// Re-export deprecation silencing controls from rayfin-lib so consumers have a
// stable public import path here; emitter helpers stay internal to the SDK.
export {
  setDeprecationsSilenced,
  isDeprecationSilenced,
} from '@microsoft/rayfin-lib';
