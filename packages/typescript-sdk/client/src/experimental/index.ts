export {
  ExtendableRayfinClient,
  ServicePlugin,
} from './ExtendableRayfinClient';
export type {
  TServiceClasses,
  ServicePluginClass,
} from './ExtendableRayfinClient';

// Connectors are generally available and live on the stable
// `@microsoft/rayfin-client` entry. These re-exports are retained so apps
// scaffolded before the promotion keep compiling; prefer the stable entry.
export { ConnectorsRayfinClient } from './ConnectorsRayfinClient';
export type { ConnectorsRayfinClientConfig } from './ConnectorsRayfinClient';

export type {
  ConnectorConfig,
  ConnectorMarker,
  ConnectorsSchema,
  OperationCatalog,
  OperationDef,
  TypedConnectorsApi,
  TypedConnectorClient,
} from '@microsoft/rayfin-connectors';
