/**
 * CLI-host implementations of the universal Fabric external-service contracts
 * defined in `@microsoft/rayfin-tools-common/_internal/external/fabric`.
 *
 * Both clients are constructed from an acquired Fabric bearer token; auth
 * acquisition stays a host concern (Layer 1) and never reaches the universal
 * steps consuming these interfaces.
 */
export {
  createCliFabricClient,
  createCliFabricReadinessClient,
} from './client.js';
export { createCliRayfinWorkloadClient } from './workload-client.js';
