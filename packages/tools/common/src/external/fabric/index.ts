/**
 * Universal Microsoft Fabric REST client (Layer 3 external client).
 *
 * Exposes two pieces: the low-level `FabricHttpClient` transport (request
 * shapes, error mapping, long-running-operation hand-off) and the higher-level
 * `FabricClient` operations interface that workflow steps depend on. Auth is
 * supplied by the host's `Http` adapter; this module imports no Node built-ins
 * and is safe in any host environment.
 */
export { FabricHttpClient } from './http-client.js';
export type { FabricClient, FabricItem, FabricWorkspace } from './client.js';
export { parsePublishableKeyResponse } from './publishable-key.js';
export {
  checkManagementEndpoint,
  createFabricStatusClient,
} from './status-client.js';
export type {
  FabricStatusClient,
  ManagementEndpointHealth,
} from './status-client.js';
export type {
  FabricCapacity,
  FabricOperationStatus,
  TrialEligibility,
  TrialEligibilityReason,
} from './capacity.js';
export {
  isActiveCapacity,
  isSelectablePaidCapacity,
  isSupportedPremiumCapacitySku,
  isTrialCapacity,
  isUsableCapacity,
  PREMIUM_CAPACITY_SKUS,
} from './capacity.js';
export {
  appendContinuationToken,
  collectPages,
  findInPages,
  readPages,
  resolveOperationPath,
} from './pagination.js';
export type { FabricPage } from './pagination.js';
export type {
  ApplyRuntimeSettingsInput,
  RayfinWorkloadClient,
  WorkloadTarget,
} from './workload-client.js';
export {
  DEPLOY_CLIENT_VERSION_KEY,
  buildRuntimeSettingsPayload,
  withoutLocalConnectorsOptIn,
} from './runtime-settings-payload.js';
export type { RuntimeSettingsPayloadInput } from './runtime-settings-payload.js';
export {
  buildFabricErrorMessage,
  FabricError,
  getRootActivityId,
  throwFabricError,
} from './errors.js';
export type {
  FabricAcceptedResponse,
  FabricHttpClientOptions,
  FabricHttpMethod,
  FabricPollableOperation,
  FabricRequestOptions,
} from './types.js';
export { CapacityManager } from './capacity-manager.js';
export { WorkspaceManager } from './workspace-manager.js';
