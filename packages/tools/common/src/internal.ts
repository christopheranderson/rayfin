export {
  DEFAULT_FABRIC_SETTINGS,
  DEFAULT_POWERBI_API_BASE_URL,
  MONIKER_HEADER,
  getFabricSettings,
  getPowerBiApiBaseUrl,
  isFabricHost,
  normalizeFabricApiUrl,
  resolveFabricPortalUrl,
  parseWorkspaceUri,
  applyWorkspaceUriOverrides,
  applyBaseApiUrlOverride,
} from './fabric.js';
export type {
  AppliedBaseApiUrlOverride,
  FabricSettings,
  ParsedWorkspaceUri,
  ResolveFabricPortalUrlOptions,
} from './fabric.js';

export { noopLogger } from './logger.js';
export type { Logger } from './logger.js';

export type {
  DeployedCodeOrigin,
  DeployOperationStatus,
  DeployStatusResponse,
} from './deploy-status.js';
export { deployStatusPath, extendedPropertiesPath } from './deploy-status.js';

export * from './feature-flags.js';

export { shellEscape } from './shell-helpers.js';

export {
  levenshtein,
  suggestClosest,
  formatDidYouMeanHint,
} from './string-distance.js';

export {
  formatHttpStatus,
  getHttpErrorRecoveryHint,
  HTTP_STATUS_INFO,
} from './http-status.js';
