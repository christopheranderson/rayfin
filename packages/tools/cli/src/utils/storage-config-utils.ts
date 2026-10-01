import {
  findExistingEnvFabricFiles,
  readDeploymentEnvFile,
} from './env-fabric-utils.js';
import { findRayfinProjectRoot } from './project-utils.js';

/**
 * Storage provider types supported by Rayfin
 */
export enum StorageProviderType {
  Azurite = 'azurite',
  OneLake = 'onelake',
}

/**
 * Storage configuration information
 */
export interface StorageConfigInfo {
  provider: StorageProviderType;
  isRemote: boolean;
  endpoint?: string;
  lakehouse?: {
    id: string;
    name: string;
    onelakeEndpoint: string;
  };
}

/**
 * Helper: read the first deployment from the deployment registry.
 */
function getFirstDeployment() {
  try {
    const projectRoot = findRayfinProjectRoot(process.cwd(), {
      verbose: false,
      silent: true,
    });
    const envFiles = findExistingEnvFabricFiles(projectRoot);
    for (const file of envFiles) {
      const deployment = readDeploymentEnvFile(projectRoot, file.workspaceName);
      if (deployment?.rayfinApiUrl) {
        return deployment;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if OneLake storage is configured (Rayfin item deployed with storage enabled).
 * In the Fabric-native model, storage is managed by the workload — the CLI only
 * needs to know if a remote deployment exists.
 * @returns true if a Rayfin item deployment is configured, false otherwise
 */
export function hasOneLakeStorage(): boolean {
  return !!getFirstDeployment()?.rayfinApiUrl;
}

/**
 * Get OneLake storage configuration.
 * In the Fabric-native model, the workload manages Lakehouse provisioning.
 * This returns a stub based on deployment metadata.
 * @returns OneLake configuration or null if not available
 */
export function getOneLakeConfig(): StorageConfigInfo['lakehouse'] | null {
  const deployment = getFirstDeployment();
  if (!deployment?.rayfinApiUrl) {
    return null;
  }

  // In the Fabric-native model, lakehouse details are managed by the workload.
  // Return a minimal stub so callers can detect remote storage is available.
  return {
    id: deployment.rayfinItemId || 'workload-managed',
    name: 'workload-managed',
    onelakeEndpoint: deployment.rayfinApiUrl,
  };
}

/**
 * Determine the appropriate storage provider based on deployment state
 * @param forceLocal - Force local development provider (Azurite)
 * @returns Storage configuration information
 */
export function getStorageConfig(forceLocal = false): StorageConfigInfo {
  if (forceLocal) {
    return {
      provider: StorageProviderType.Azurite,
      isRemote: false,
    };
  }

  const oneLakeConfig = getOneLakeConfig();

  if (oneLakeConfig) {
    return {
      provider: StorageProviderType.OneLake,
      isRemote: true,
      lakehouse: oneLakeConfig,
    };
  }

  return {
    provider: StorageProviderType.Azurite,
    isRemote: false,
  };
}

/**
 * Check if storage is configured for remote deployment
 * @returns true if remote storage (OneLake) is available, false otherwise
 */
export function hasRemoteStorage(): boolean {
  return hasOneLakeStorage();
}
