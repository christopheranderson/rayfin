import { validateServiceDependencies } from '@microsoft/rayfin-tools-common/_internal/config';

import { loadRayfinConfig } from './config-utils.js';
import {
  modeLog,
  modeError,
  type OutputMode,
  resolveOutputMode,
} from './output-mode.js';
import {
  getRemoteEndpoint,
  getRemoteAuthorizationHeader,
  getRemoteStorageConfigUrl,
  hasRemoteEndpoint,
} from './remote-endpoint-utils.js';
import { applyStorageConfigToServer } from './storage-apply.js';
import { generateStorageConfig } from './storage-config-generator.js';
import {
  getStorageConfig,
  StorageProviderType,
} from './storage-config-utils.js';

// Reusable function for watcher (not tied to Commander)
export async function applyStorageConfig({
  remote = false,
  force = false,
  exitOnError = false,
  mode,
}: {
  remote?: boolean;
  force?: boolean;
  exitOnError?: boolean;
  mode?: OutputMode;
} = {}) {
  const resolvedMode = mode ?? resolveOutputMode({ json: false });
  const rayfinConfig = loadRayfinConfig(undefined, { silent: true });
  if (rayfinConfig) {
    const [dependencyError] = validateServiceDependencies({
      dataEnabled: rayfinConfig.services.data.enabled === true,
      storageEnabled: true,
    });
    if (dependencyError) {
      modeError(resolvedMode, `❌ ${dependencyError.message}`);
      modeError(resolvedMode, `   ${dependencyError.hint}`);
      if (exitOnError) {
        throw new Error(dependencyError.message);
      }
      return;
    }
  }

  // Get storage configuration to show provider information
  const storageConfig = getStorageConfig(!remote);

  if (remote && !hasRemoteEndpoint()) {
    modeError(resolvedMode, '❌ No remote endpoint configured');
    modeError(
      resolvedMode,
      "💡 Run 'rayfin up' first to deploy and configure the remote endpoint"
    );
    if (exitOnError) {
      throw new Error('No remote endpoint configured');
    }
  }

  try {
    if (remote) {
      modeLog(resolvedMode, '🌐 Storage Apply (Remote Mode)\n');
      modeLog(resolvedMode, '🎯 Target: Remote Rayfin item workload endpoint');
      modeLog(resolvedMode, `📍 Endpoint: ${getRemoteEndpoint()!}`);

      if (
        storageConfig.provider === StorageProviderType.OneLake &&
        storageConfig.lakehouse
      ) {
        modeLog(
          resolvedMode,
          `🏞️  Storage: OneLake (${storageConfig.lakehouse.name})`
        );
        modeLog(resolvedMode, `📦 Lakehouse ID: ${storageConfig.lakehouse.id}`);
      } else {
        modeLog(
          resolvedMode,
          '⚠️  Storage: OneLake not configured, will use default storage'
        );
      }
    } else {
      modeLog(resolvedMode, '🏠 Storage Apply (Local Mode)\n');
      modeLog(resolvedMode, '🎯 Target: Local development server');
      modeLog(resolvedMode, '📦 Storage: Azurite (local emulator)');
    }

    if (force) {
      modeLog(
        resolvedMode,
        '⚠️  Force mode: ON (will attempt to reconcile conflicting folder metadata)'
      );
    }

    modeLog(resolvedMode, '🔧 Generating storage configuration...');
    const result = await generateStorageConfig({
      verbose: false,
      mode: resolvedMode,
    });
    modeLog(resolvedMode, `✅ Configuration generated: ${result.configPath}`);

    const endpoint = remote ? getRemoteStorageConfigUrl()! : undefined;
    const authorizationHeader = remote
      ? await getRemoteAuthorizationHeader()
      : undefined;
    await applyStorageConfigToServer(
      result.configPath,
      endpoint,
      force,
      remote,
      authorizationHeader,
      { mode: resolvedMode }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (remote) {
      modeError(
        resolvedMode,
        '❌ Failed to apply storage configuration to remote endpoint'
      );
    } else {
      modeError(
        resolvedMode,
        '❌ Failed to apply storage configuration to local server'
      );
    }
    modeError(resolvedMode, '   ' + msg);

    if (exitOnError) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
