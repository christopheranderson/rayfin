import { existsSync, readFileSync } from 'fs';

import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import {
  applyDataConfigWithRetries,
  type DataApplyRetryOptions,
} from '@microsoft/rayfin-tools-common/_internal/services/data';

import { getWebServicePort } from './env-file-utils.js';
import {
  postFabricJson,
  postJson,
  throwIfNotOk,
  wrapConnectionError,
} from './http-client.js';
import { modeLog, type OutputMode, resolveOutputMode } from './output-mode.js';

export interface ApplyConfigToServerOptions {
  diagnostics?: Diagnostics;
  /** Retry transient failures from the HTTP request. */
  retryTransientErrors?: boolean;
  /** Internal retry overrides used by tests and non-default hosts. */
  retryOptions?: DataApplyRetryOptions;
}

/**
 * Apply the generated DAB configuration to a running DAB server
 * @param configPath - Path to the dab-config.json file
 * @param endpoint - Custom endpoint (defaults to local DAB server)
 * @param force - Force DAB controller to accept configuration that may result in data loss
 * @param remote - Whether the target is a remote Fabric workload endpoint
 * @param authorizationHeader - Optional Authorization header value to include in the request
 * @throws `Error` if config file doesn't exist, is invalid JSON, or server request fails
 */
export async function applyConfigToServer(
  configPath: string,
  endpoint?: string,
  force = false,
  remote = false,
  authorizationHeader?: string,
  extraHeaders?: Record<string, string>,
  mode?: OutputMode,
  options: ApplyConfigToServerOptions = {}
): Promise<void> {
  const resolvedMode = mode ?? resolveOutputMode({ json: false });
  const startTime = Date.now();

  modeLog(resolvedMode, '🚀 Apply DAB configuration to server\n');

  // If no endpoint provided, read port from .env and construct URL
  if (!endpoint) {
    const port = await getWebServicePort();
    endpoint = `http://localhost:${port}/api/applyconfig`;
  }

  // Check if config file exists
  if (!existsSync(configPath)) {
    throw new Error(`DAB configuration file not found: ${configPath}`);
  }

  modeLog(resolvedMode, `📄 Reading config from: ${configPath}`);

  // Read the configuration file
  const configContent = readFileSync(configPath, 'utf-8');

  try {
    JSON.parse(configContent);
  } catch (error) {
    throw new Error(
      `Invalid JSON in configuration file: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  modeLog(resolvedMode, `📡 Applying configuration to Rayfin server...`);
  if (force) {
    modeLog(
      resolvedMode,
      `⚠️  Using force mode - DAB will accept configuration that may result in data loss`
    );
  }

  // Send POST request to DAB server

  // Wrap the config in the expected format
  const payload = {
    ConfigData: configContent,
    Force: force,
  };

  try {
    const post = remote ? postFabricJson : postJson;
    const apply = async (): Promise<string> => {
      const response = await post({
        url: endpoint,
        body: payload,
        authorizationHeader,
        extraHeaders,
        diagnostics: options.diagnostics,
      });
      return throwIfNotOk(response, 'DAB server responded with error');
    };
    const responseData = options.retryTransientErrors
      ? await applyDataConfigWithRetries(apply, options.retryOptions)
      : await apply();

    const duration = Date.now() - startTime;

    modeLog(resolvedMode, `✅ Configuration applied successfully!`);
    if (responseData && responseData.trim()) {
      modeLog(resolvedMode, `📝 Server response: ${responseData}`);
    }
    modeLog(resolvedMode, `⏱️  Apply completed in ${duration}ms`);
  } catch (error) {
    wrapConnectionError(error, endpoint);
  }
}
