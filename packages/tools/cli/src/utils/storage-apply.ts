import { existsSync, readFileSync } from 'fs';

import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { StorageApplyError } from '@microsoft/rayfin-tools-common/_internal/services/storage';

import { getWebServicePort } from './env-file-utils.js';
import {
  postFabricJson,
  postJson,
  throwIfNotOk,
  wrapConnectionError,
} from './http-client.js';
import { modeLog, resolveOutputMode, type OutputMode } from './output-mode.js';
import { HttpError } from './retry-utils.js';

export interface ApplyStorageOptions {
  endpoint?: string;
  force?: boolean;
}

export interface StorageApplyOutputOptions {
  diagnostics?: Diagnostics;
  mode?: OutputMode;
  writeDiagnostic?: (text: string) => void;
}

/**
 * Read the notice an `ExperimentalFeature` filter attaches to its 404, or
 * `undefined` when the 404 came from somewhere else.
 *
 * That filter answers with a `NotFoundObjectResult` whose body is the sentence
 * "&lt;Feature&gt; is an experimental feature and is not yet available for this
 * workspace.", serialized as a bare JSON string. Matching on the phrase rather
 * than the exact sentence keeps this working if the server rewords it; anything
 * unrecognized falls through so a genuine missing-route 404 still reports as
 * one.
 *
 * Never throws: a body that cannot be read is simply "not the feature gate".
 */
async function readExperimentalFeatureNotice(
  response: Response
): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;

  // The body is a JSON string; fall back to the raw text when it is not.
  let notice = text.trim();
  try {
    const parsed: unknown = JSON.parse(notice);
    if (typeof parsed === 'string') {
      notice = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const candidate = record['message'] ?? record['title'] ?? record['error'];
      if (typeof candidate === 'string') notice = candidate;
    }
  } catch {
    // Not JSON - keep the raw text.
  }

  return /experimental feature/iu.test(notice) ? notice : undefined;
}

/**
 * Apply the generated storage configuration to a running Rayfin webservice
 * @param configPath - Path to the storage-config.json file
 * @param endpoint - Custom endpoint (defaults to local webservice storage apply endpoint)
 * @param force - Force controller to apply conflicting changes (`onConflict` / rules)
 * @param remote - Whether the target is a remote Fabric workload endpoint
 * @param authorizationHeader - Optional Authorization header value to include in the request
 * @param output - Output mode and optional diagnostic sink
 * @throws `Error` if config file missing, invalid JSON, or server request fails
 */
export async function applyStorageConfigToServer(
  configPath: string,
  endpoint?: string,
  force = false,
  remote = false,
  authorizationHeader?: string,
  output: StorageApplyOutputOptions = {}
): Promise<void> {
  const startTime = Date.now();
  const mode = output.mode ?? resolveOutputMode({ json: false });

  modeLog(mode, '📦 Apply storage configuration to server\n');

  if (!existsSync(configPath)) {
    throw new Error(`Storage configuration file not found: ${configPath}`);
  }

  modeLog(mode, `📄 Reading config from: ${configPath}`);
  const configContent = readFileSync(configPath, 'utf-8');

  let parsed: any;
  try {
    parsed = JSON.parse(configContent);
  } catch (error) {
    throw new Error(
      `Invalid JSON in storage configuration file: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed.folders || !Array.isArray(parsed.folders)) {
    throw new Error("Storage configuration missing 'folders' array");
  }

  if (parsed.folders.length === 0) {
    modeLog(mode, 'ℹ️  No storage folders found; skipping storage apply.');
    return;
  }

  // Resolve the endpoint only when there is configuration to apply.
  if (!endpoint) {
    const port = await getWebServicePort();
    endpoint = `http://localhost:${port}/api/applystorageconfig`;
  }

  modeLog(
    mode,
    `📡 Applying storage configuration to Rayfin server: ${endpoint}...`
  );
  if (force) {
    modeLog(
      mode,
      '⚠️  Force mode: ON (will attempt to reconcile conflicting folder metadata)'
    );
  }

  const payload = parsed; // Already in expected shape { schemaVersion, folders: [ ... ] }

  try {
    const url = new URL(endpoint);
    if (force) {
      url.searchParams.set('force', 'true');
    }
    const post = remote ? postFabricJson : postJson;
    const response = await post({
      url: url.toString(),
      body: payload,
      authorizationHeader,
      extraHeaders: {
        'X-Correlation-ID': crypto.randomUUID(),
      },
      diagnostics: output.diagnostics,
    });

    // Domain-specific: a 404 here has two very different causes, and telling a
    // Builder to upgrade a server that is already current sends them down the
    // wrong path. The `ExperimentalFeature` filter in front of the storage
    // controller short-circuits with 404 and an explanatory body when
    // `FeatureFlags:EnableStorage` is off, so read the body before blaming the
    // build.
    if (response.status === 404) {
      const disabledDetail = await readExperimentalFeatureNotice(response);
      throw new StorageApplyError(
        disabledDetail
          ? 'Storage apply is disabled on the server at ' +
              endpoint +
              `\n   ${disabledDetail}` +
              '\n\uD83D\uDCA1 Storage is still a preview feature and is gated ' +
              'server-side by `FeatureFlags:EnableStorage`. For the local dev ' +
              'stack, set `FeatureFlags__EnableStorage=true` in `rayfin/.env` ' +
              'and restart it with `rayfin dev`.'
          : 'Storage apply endpoint not found (404) at ' +
              endpoint +
              '\n\uD83D\uDCA1 This likely means the Rayfin webservice version does not ' +
              'support storage apply. Upgrade the Rayfin webservice.',
        404,
        'request-failed'
      );
    }

    // Domain-specific: 409 means the declarative replace would drop folders
    // that still contain objects. The server refuses without `force`.
    if (response.status === 409) {
      const conflictText = await response.text();
      let blocked: string[] = [];
      let serverMessage = '';
      try {
        const conflictBody = JSON.parse(conflictText);
        if (Array.isArray(conflictBody?.removalsBlocked)) {
          blocked = conflictBody.removalsBlocked;
        }
        serverMessage =
          conflictBody?.message ?? conflictBody?.error?.message ?? '';
      } catch {
        serverMessage = conflictText.trim();
      }
      const detail =
        blocked.length > 0
          ? 'the following folder(s) are no longer declared but still contain ' +
            `objects and were not removed:\n   • ${blocked.join('\n   • ')}`
          : serverMessage ||
            'the server rejected removal of one or more non-empty folders.';
      throw new StorageApplyError(
        'Storage apply blocked (409): ' +
          detail +
          '\n💡 Re-run with --force to authorize removing non-empty folders.',
        409,
        'removal-blocked'
      );
    }

    const text = await throwIfNotOk(response, 'Storage controller error');

    let result: any = undefined;
    try {
      result = text ? JSON.parse(text) : undefined;
    } catch {
      // non-json payload acceptable
    }

    const duration = Date.now() - startTime;
    modeLog(mode, '✅ Storage configuration applied successfully!');
    if (result) {
      modeLog(
        mode,
        `📊 Created: ${result.createdFolders?.length || 0} | Replaced: ${result.replacedFolders?.length || 0} | Removed: ${result.removedFolders?.length || 0} | Manifest v${result.manifestVersion ?? '?'}`
      );
      if (result.warnings && result.warnings.length > 0) {
        const warningText = [
          '⚠️  Warnings:',
          ...result.warnings.map((warning: string) => `   • ${warning}`),
        ].join('\n');
        output.diagnostics?.debug({
          area: 'storage.warning',
          message: warningText,
        });
        if (output.writeDiagnostic) {
          output.writeDiagnostic(warningText + '\n');
        } else {
          modeLog(mode, warningText);
        }
      }
      if (result.correlationId) {
        modeLog(mode, `🧾 Correlation ID: ${result.correlationId}`);
      }
    }
    modeLog(mode, `⏱️  Apply completed in ${duration}ms`);
  } catch (error) {
    if (error instanceof StorageApplyError) {
      throw error;
    }
    if (error instanceof HttpError) {
      throw new StorageApplyError(
        error.message,
        error.statusCode,
        'request-failed',
        { cause: error }
      );
    }
    wrapConnectionError(error, endpoint);
  }
}
