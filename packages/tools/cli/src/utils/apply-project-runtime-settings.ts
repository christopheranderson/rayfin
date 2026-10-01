import { join } from 'path';

import { type RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type { FrontendDevPortResolution } from '@microsoft/rayfin-tools-common/_internal/services/dev-redirect';
import {
  type RuntimeSettingsServices,
  toRuntimeSettingsServices,
  translateStaticHostingAccessError,
} from '@microsoft/rayfin-tools-common/_internal/services/runtime-settings';
import ora from 'ora';

import { DevConfig } from '../commands/dev/dev';

import { getWebServicePort } from './env-file-utils.js';
import {
  appendLocalDevRedirectUrisForPort,
  resolveFrontendDevPort,
} from './frontend-dev-port.js';
import { postFabricJson, postJson, throwIfNotOk } from './http-client.js';
import {
  createProgress,
  wrapOraSpinner,
  type OutputMode,
  resolveOutputMode,
} from './output-mode.js';
import {
  getRemoteAuthorizationHeader,
  getRemoteRuntimeSettingsUrl,
  hasRemoteEndpoint,
} from './remote-endpoint-utils.js';

const RETRY_DELAY_MS = 6000;
const MAX_RETRIES = 30;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableError = (error: Error): boolean => {
  const message = error.message.toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('cannot connect') ||
    message.includes('connection refused')
  );
};

interface ApplyProjectRuntimeSettingsOptions {
  mode?: OutputMode;
  frontendDevPort?: FrontendDevPortResolution;
}

/**
 * Send runtime settings to the web service API
 * @param config - Dev configuration
 * @param rayfinConfig - runtime settings configuration from rayfin.yml
 * @param options - Rendering mode and optional command-prepared frontend port resolution
 */
export const applyProjectRuntimeSettingsWithRetries = async (
  config: DevConfig,
  rayfinConfig: any,
  options: ApplyProjectRuntimeSettingsOptions = {}
): Promise<void> => {
  const resolvedMode = options.mode ?? resolveOutputMode({ json: false });
  // In CI mode, spinner updates don't produce newlines, so we log explicitly
  const isCI = process.env.CI === 'true';
  let spinner;
  if (resolvedMode !== 'interactive') {
    spinner = createProgress(
      resolvedMode,
      'Applying project runtime settings',
      { prefix: '[rayfin]' }
    );
  } else {
    spinner = wrapOraSpinner(
      ora('🔧 Applying project runtime settings...').start(),
      'Applying project runtime settings'
    );
  }

  let lastError: Error | null = null;
  const payloadPromise = rayfinConfig
    ? getRuntimeSettingsPayload(
        config,
        rayfinConfig,
        { remote: false },
        options.frontendDevPort
      )
    : Promise.resolve(undefined);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        const retryMsg = `Retry attempt ${attempt}/${MAX_RETRIES}...`;
        if ('text' in spinner) {
          (spinner as any).text = retryMsg;
        }
        if (isCI) {
          console.log(`🔄 ${retryMsg}`);
        }
      }

      const payload = await payloadPromise;
      await applyProjectRuntimeSettings(
        config,
        rayfinConfig,
        payload,
        false,
        true
      );

      spinner.succeed('✅ Project runtime settings applied successfully!');
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isRetryableError(lastError)) {
        spinner.fail('❌ Project runtime settings apply failed');
        console.error(`   ${lastError.message}`);
        console.error(
          '\n   This appears to be a configuration error, not a connection issue.'
        );
        throw lastError;
      }

      if (attempt < MAX_RETRIES) {
        const waitMsg = `Waiting before retry ${attempt + 1}/${MAX_RETRIES}...`;
        if ('text' in spinner) {
          (spinner as any).text = waitMsg;
        }
        if (isCI) {
          console.log(`⏳ ${waitMsg}`);
        }
        await wait(RETRY_DELAY_MS);
      }
    }
  }

  // Exhausted retries due to connection issues
  if (lastError && isRetryableError(lastError)) {
    spinner.fail(
      '❌ Failed to apply project runtime settings after multiple attempts'
    );
    console.error(
      '   The service may still be starting. Please retry after some time.'
    );
    throw lastError;
  }
};

const applyProjectRuntimeSettings = async (
  config: DevConfig,
  rayfinConfig: RayfinConfig | null,
  payload: RuntimeSettingsServices | undefined,
  remote = false,
  propagateError = false
): Promise<void> => {
  if (!rayfinConfig) {
    console.warn(
      '⚠️  No rayfin.yml configuration found - skipping runtime settings sync'
    );
    return;
  }

  // Connectors only take effect on the cloud (`rayfin up`). When running
  // locally, warn that any configured connectors are skipped so Builders are
  // not surprised when their connector-backed data is unavailable.
  if (!remote && hasConfiguredConnectors(rayfinConfig)) {
    console.warn(
      '⚠️  Connectors are not supported in local development - they will be skipped'
    );
    console.warn(
      "💡 Run 'rayfin up' to deploy connectors to the cloud environment"
    );
  }

  // Check remote endpoint when explicitly in remote mode
  if (remote && !hasRemoteEndpoint()) {
    console.warn(
      '⚠️  No remote endpoint configured - skipping runtime settings sync'
    );
    console.warn(
      "💡 Run 'rayfin up' first to deploy and configure the remote endpoint"
    );
    return;
  }

  try {
    const apiUrl = remote
      ? getRemoteRuntimeSettingsUrl()!
      : await getLocalApplyRuntimeSettingsUrl(config);

    const authorizationHeader = remote
      ? await getRemoteAuthorizationHeader()
      : undefined;

    const post = remote ? postFabricJson : postJson;
    const response = await post({
      url: apiUrl,
      body: payload,
      authorizationHeader,
    });

    await throwIfNotOk(
      response,
      'Failed to sync',
      translateStaticHostingAccessError
    );
  } catch (err) {
    if (propagateError) {
      throw err;
    }

    logRuntimeSettingsError(err, remote);
  }
};

const hasConfiguredConnectors = (rayfinConfig: RayfinConfig): boolean =>
  rayfinConfig.connectors !== undefined &&
  Object.keys(rayfinConfig.connectors).length > 0;

const getRuntimeSettingsPayload = async (
  config: DevConfig,
  rayfinConfig: RayfinConfig,
  options: { remote: boolean },
  frontendDevPort?: FrontendDevPortResolution
): Promise<RuntimeSettingsServices> => {
  if (options.remote || !rayfinConfig.services.auth?.enabled) {
    return toRuntimeSettingsServices(rayfinConfig.services);
  }

  const resolution =
    frontendDevPort ??
    (await resolveFrontendDevPort(join(config.projectRoot, 'rayfin')));
  let services = rayfinConfig.services;
  for (const port of resolution.redirectPorts) {
    services = appendLocalDevRedirectUrisForPort(services, port);
  }
  return toRuntimeSettingsServices(services);
};

const getLocalApplyRuntimeSettingsUrl = async (
  config: DevConfig
): Promise<string> => {
  const rayfinDir = join(config.projectRoot, 'rayfin');
  const port = await getWebServicePort(rayfinDir);
  return `http://localhost:${port}/api/projectRuntimeSettings`;
};

const logRuntimeSettingsError = (err: unknown, remote: boolean): void => {
  const message = err instanceof Error ? err.message : String(err);

  if (remote) {
    console.error(
      '❌ Failed to sync project runtime settings to remote endpoint'
    );
    console.error(`   ${message}`);
    console.error('\n💡 Troubleshooting tips for remote sync:');
    console.error('   • Verify the container app is running and healthy');
    console.error("   • Check if 'rayfin up' completed successfully");
    console.error('   • Ensure your network can reach the remote endpoint');
  } else {
    console.error('❌ Failed to sync project runtime settings to local server');
    console.error(`   ${message}`);
    console.error('\n💡 Troubleshooting tips for local sync:');
    console.error("   • Start the local server with 'rayfin dev'");
    console.error('   • Wait for health checks to pass before syncing');
  }
};
