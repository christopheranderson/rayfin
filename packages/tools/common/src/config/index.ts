export {
  coerceType,
  interpolateConfig,
  interpolateString,
} from './interpolation.js';

export {
  parseRayfinYaml,
  parseRayfinYamlInterpolated,
  normalizeConnectorsBlock,
} from './parseRayfinYaml.js';

export {
  clearDeploymentPublicEnv,
  composeFabricItemDeepLink,
  DEPLOYMENT_PUBLIC_ENV_KEYS,
  deploymentInfoToPublicEnv,
  extractPortalUrl,
  mapPublicEnvForFramework,
  mapPublicEnvKey,
  mergeEnvVars,
  parseEnvContent,
  RAYFIN_PUBLIC_PREFIX,
  sanitizeWorkspaceName,
  serializeEnvContent,
} from './env.js';

export type { FrontendFramework } from './env.js';

export {
  DatabaseDialect,
  STATIC_HOSTING_ASSET_ACCESS_VALUES,
} from './types.js';

export {
  Connector,
  FABRIC_SEMANTIC_MODEL_CONNECTOR_OPERATIONS,
  FABRIC_SQL_CONNECTOR_OPERATIONS,
  KUSTO_CONNECTOR_OPERATIONS,
  LAKEHOUSE_CONNECTOR_OPERATIONS,
} from './types.js';

export type {
  AuthMethod,
  ConnectorAuthSettings,
  ConnectorAuthType,
  ConnectorType,
  ConnectorOperationType,
  DeploymentInfo,
  DeploymentsRegistry,
  Dialect,
  FabricConfig,
  FabricSemanticModelConnectorOperationType,
  FabricSqlConnectorOperationType,
  FrontendConfig,
  FrontendFrameworkConfig,
  FunctionsAuthConfig,
  FunctionsAuthType,
  FunctionsConfig,
  KustoConnectorOperationType,
  LakehouseConnectorOperationType,
  MagicLinkConfig,
  PasswordConfig,
  PasswordlessConfig,
  RayfinConfig,
  SmsOtpConfig,
  ConnectorConfigSettings,
  ConnectorEntry,
  StaticHostingConfig,
  StaticHostingAssetAccess,
  EmbeddedHostingConfig,
} from './types.js';

export { deepMerge } from './utils.js';

export {
  CONNECTOR_CATALOG,
  ConnectorAuth,
  ConnectorConfigArg,
  suggestConnectorType,
} from './connectors.js';

export type {
  ConnectorAuthoringPolicy,
  ConnectorMeta,
  ConnectorPackageRef,
} from './connectors.js';

export type {
  ConnectorDiscoveryProvider,
  DiscoveredSource,
  DiscoveredSourceCapabilities,
  DiscoveryRequest,
  DiscoveryScope,
  WorkspaceRole,
} from './discovery.js';

export {
  isValidConnectorName,
  KNOWN_CONNECTOR_TYPES,
  parseConnectorOperations,
  validateConnectors,
} from './validateConnectors.js';

export type {
  ConnectorValidationError,
  ParseConnectorOperationsResult,
} from './validateConnectors.js';

export { validateFunctionsConfig } from './validateFunctionsConfig.js';
export type { FunctionsConfigValidationError } from './validateFunctionsConfig.js';

export { addAllowedRedirectUri } from './redirectUri.js';

export { validateServiceDependencies } from './serviceDependencies.js';
export type {
  ServiceDependencyState,
  ServiceDependencyValidationError,
} from './serviceDependencies.js';
