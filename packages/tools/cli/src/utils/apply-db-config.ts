import { Dialect } from '@microsoft/rayfin-core/analysis';
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { DataApplyRetryOptions } from '@microsoft/rayfin-tools-common/_internal/services/data';

import { MONIKER_HEADER } from '../config/constants.js';
import { CliHandledError } from '../errors.js';

import type { ServiceBuildOptions } from './config-utils.js';
import { applyConfigToServer } from './dab-apply.js';
import { generateDabConfig } from './dab-config-generator.js';
import {
  modeLog,
  modeError,
  type OutputMode,
  resolveOutputMode,
} from './output-mode.js';
import {
  getActiveDeploymentEnvVars,
  getRemoteApplyConfigUrl,
  getRemoteEndpoint,
  getRemoteAuthorizationHeader,
  hasRemoteEndpoint,
} from './remote-endpoint-utils.js';

// Reusable function for watcher (not tied to Commander)
export async function applyDbConfig({
  remote = false,
  force = false,
  verbose = false,
  exitOnError = false,
  propagateError = false,
  dialect = 'mssql',
  remoteEndpoint,
  authorizationHeader: authorizationHeaderOverride,
  rayfinItemId,
  mode,
  projectRoot,
  serviceRoot,
  buildCommand,
  silentBuild,
  writeBuildOutput,
  diagnostics,
  buildOutput,
  compileMode,
  retryTransientErrors = false,
  retryOptions,
}: {
  remote?: boolean;
  force?: boolean;
  verbose?: boolean;
  diagnostics?: Diagnostics;
  buildOutput?: ServiceBuildOptions['output'];
  compileMode?: OutputMode;
  exitOnError?: boolean;
  propagateError?: boolean;
  dialect?: Dialect;
  /** Pre-resolved remote endpoint URL (skips automatic resolution). */
  remoteEndpoint?: string;
  /**
   * Pre-resolved `Bearer <token>` authorization header. When provided on a
   * remote apply it is used directly instead of reacquiring auth, so the
   * caller's resolved credentials are honored — e.g. the token `rayfin up`
   * already acquired with `--tenant` / `--encryption-fallback-enabled`. When
   * omitted, the header is reacquired via the secure credential chain (the
   * standalone `up db apply` path).
   */
  authorizationHeader?: string;
  /**
   * Rayfin item id to send as the workload resource moniker. When omitted on a
   * remote apply, the active deployment's recorded id is used. Required during
   * `rayfin up`, where the apply runs before the deployment is recorded and the
   * registry fallback would resolve to a stale (or absent) id.
   */
  rayfinItemId?: string;
  mode?: OutputMode;
  /** Pre-resolved Rayfin project root. Avoids rediscovery and its CLI output. */
  projectRoot?: string;
  /** Resolved data service root (from `services.data.path`). Defaults to the Rayfin project root. */
  serviceRoot?: string;
  /** Build command to execute before entity compilation. */
  buildCommand?: string;
  /** Retry transient failures from the remote HTTP apply, but not generation. */
  retryTransientErrors?: boolean;
  /** Retry diagnostics and timing overrides for the remote HTTP apply. */
  retryOptions?: DataApplyRetryOptions;
  /**
   * Capture the data build command's output instead of streaming it live,
   * surfacing it only on failure. Set by the v2 `up` data service so it does
   * not interleave with the Layer 1 spinner; legacy callers omit it.
   */
  silentBuild?: boolean;
  /**
   * Receives a failed data build's captured output (used with `silentBuild`).
   * The v2 data service passes a spinner-aware writer; defaults to `stderr`.
   */
  writeBuildOutput?: (text: string) => void;
} = {}) {
  const resolvedMode = mode ?? resolveOutputMode({ json: false });
  // Early validation for remote mode
  if (remote && !remoteEndpoint && !hasRemoteEndpoint()) {
    modeError(resolvedMode, '❌ No remote endpoint configured');
    modeError(
      resolvedMode,
      "💡 Run 'rayfin up' first to deploy and configure the remote endpoint"
    );
    // Throw on this preflight failure for callers that want errors surfaced
    // (`exitOnError` for the CLI top-level handler, `propagateError` for
    // programmatic callers such as the workflow services). Without this, a
    // remote apply with no configured endpoint would fall through and apply
    // to the LOCAL dev server (or fail with a misleading local connection
    // error) instead of reporting the missing endpoint.
    if (exitOnError || propagateError) {
      // Message already displayed above — wrap in CliHandledError so the
      // top-level handler does not print it a second time.
      throw new CliHandledError(new Error('No remote endpoint configured'));
    }
  }

  try {
    // Display target information with visual distinction
    if (remote) {
      modeLog(resolvedMode, '🌐 DB Apply (Remote Mode)\n');

      modeLog(resolvedMode, `🎯 Target: Remote Rayfin item workload endpoint`);
      modeLog(
        resolvedMode,
        `📍 Endpoint: ${remoteEndpoint || getRemoteEndpoint()!}`
      );
    } else {
      modeLog(resolvedMode, '\n🏠 DB Apply (Local Mode)\n');
      modeLog(resolvedMode, `🎯 Target: Local development server`);
    }

    if (force) {
      modeLog(
        resolvedMode,
        `⚠️  Force mode: ON (will accept configuration that may result in data loss)`
      );
    }

    // Step 1: Generate DAB configuration (always regenerate)
    modeLog(resolvedMode, '🔧 Generating DAB configuration...');
    const result = await generateDabConfig({
      dialect,
      verbose,
      projectRoot,
      serviceRoot,
      buildCommand,
      silentBuild,
      writeBuildOutput,
      diagnostics,
      buildOutput,
      compileMode,
    });

    if (result.entities.length === 0) {
      modeLog(
        resolvedMode,
        'ℹ️  No entity classes found — skipping database configuration apply.'
      );
      return;
    }

    modeLog(resolvedMode, `✅ Configuration generated: ${result.configPath}\n`);

    // Step 2: Apply configuration to target endpoint
    const endpoint = remote
      ? remoteEndpoint
        ? `${remoteEndpoint.replace(/\/$/, '')}/__private/applyconfig`
        : getRemoteApplyConfigUrl()!
      : undefined;
    const authorizationHeader = remote
      ? (authorizationHeaderOverride ?? (await getRemoteAuthorizationHeader()))
      : undefined;
    // The Fabric public API gateway routes `/__private/*` requests (and their
    // bodies) to the correct workload backend via the resource moniker. Every
    // other remote management call (`up`, `up staticapp`, `up functions`, …)
    // sends this header; omitting it here caused the request body — including
    // `Force` — to not reach the backend for `up db apply`.
    //
    // A caller-supplied `rayfinItemId` wins over the active-deployment lookup:
    // during `rayfin up` the apply runs before the deployment is recorded, so
    // the registry fallback would resolve to a stale (or absent) id.
    const resolvedItemId = remote
      ? (rayfinItemId ?? getActiveDeploymentEnvVars()?.rayfinItemId)
      : undefined;
    const extraHeaders = resolvedItemId
      ? { [MONIKER_HEADER]: resolvedItemId }
      : undefined;
    await applyConfigToServer(
      result.configPath,
      endpoint,
      force,
      remote,
      authorizationHeader,
      extraHeaders,
      resolvedMode,
      {
        retryTransientErrors: remote && retryTransientErrors,
        retryOptions,
        diagnostics,
      }
    );
  } catch (error) {
    if (propagateError) {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    if (remote) {
      modeError(
        resolvedMode,
        '❌ Failed to apply configuration to remote endpoint'
      );
      modeError(resolvedMode, `   ${errorMessage}`);
      modeError(resolvedMode, '\n💡 Troubleshooting tips for remote apply:');
      modeError(
        resolvedMode,
        '   • Verify the Rayfin item workload is running and healthy'
      );
      modeError(
        resolvedMode,
        "   • Check if 'rayfin up' completed successfully"
      );
      modeError(
        resolvedMode,
        '   • Ensure your network can reach the remote endpoint'
      );
    } else {
      modeError(
        resolvedMode,
        '❌ Failed to apply configuration to local server'
      );
      modeError(resolvedMode, `   ${errorMessage}`);
      modeError(resolvedMode, '\n💡 Troubleshooting tips for local apply:');
      modeError(resolvedMode, "   • Start the local server with 'rayfin dev'");
      modeError(
        resolvedMode,
        '   • Wait for health checks to pass before applying'
      );
    }
    if (exitOnError) {
      // The formatted error block above is the user-facing message. Wrap
      // the rethrow in CliHandledError so the top-level handler doesn't
      // double-print.
      throw new CliHandledError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}
