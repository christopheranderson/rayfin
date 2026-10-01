/**
 * Shared helper for persisting a static hosting URL after deployment.
 *
 * Used by both `rayfin up` and `rayfin up staticapp deploy` to avoid
 * duplicating the callback-URI construction, allowedRedirectUris update,
 * runtime-settings POST, and deployment registry hosting URL persistence.
 */

import { addAllowedRedirectUri } from '@microsoft/rayfin-tools-common/_internal/config';

import type { RayfinConfig } from '../types/config.js';

import { writeRayfinConfigUpdates } from './config-utils.js';
import {
  persistDeploymentEnvFile,
  readDeploymentEnvFileState,
} from './env-fabric-utils.js';
import { envBackupNoticeLines } from './env-file-utils.js';
import { warnAboutLegacyMigrations } from './migration-utils.js';
import {
  modeLog,
  modeWarn,
  type OutputMode,
  resolveOutputMode,
} from './output-mode.js';

// Re-export from the shared common package so existing CLI consumers
// that import from here keep working.
export { addAllowedRedirectUri };
/**
 * Options for {@link persistHostingUrl}.
 */
export interface PersistHostingUrlOptions {
  /** The hosting URL returned by the deploy API. */
  hostingUrl: string;
  /** Current services config from rayfin.yml. */
  services: RayfinConfig['services'];
  /** Absolute path to the project root (contains rayfin.yml). */
  projectRoot: string;
  /** Workspace display name used to locate the deployment record. */
  workspaceName: string;
  /**
   * Optional: POST the updated services to the backend.
   * When provided, the function calls this to re-apply runtime settings.
   * Pass `null` to skip the backend POST (e.g. when no endpoint is available).
   */
  postSettings?: (updatedServices: RayfinConfig['services']) => Promise<void>;
  /**
   * Output mode for the decorative success line. Defaults to the resolved
   * mode; the v2 `up` static service passes `'silent'` so it does not
   * interleave with the Layer 1 spinner.
   */
  mode?: OutputMode;
  /**
   * Receives the redirect-URI update failure warning. When provided (the v2
   * `up` static service passes a spinner-aware writer) the warning is always
   * shown regardless of `mode`, so a swallowed failure is never silent.
   * Defaults to `modeWarn` under the resolved mode.
   */
  writeWarning?: (text: string) => void;
}

/** Facts produced by output-free hosting URL persistence. */
export interface HostingUrlPersistenceResult {
  configUpdated: boolean;
  redirectUriUpdated: boolean;
  workspaceKey?: string;
  envBackup?: { sourcePath: string; backupPath: string };
  warnings: string[];
}

/**
 * Persists a hosting URL after static content deployment.
 *
 * 1. Adds the bare hosting origin to `allowedRedirectUris`
 *    (required for Fabric/Power BI embedded postMessage handoff,
 *    independent of whether auth is enabled).
 * 2. POSTs updated settings to the backend (if `postSettings` provided)
 *    and persists `allowedRedirectUris` to `rayfin.yml` whenever the
 *    list changed.
 * 3. Writes the hosting URL to the deployment registry
 *    (`rayfin/.deployments.json`) for the active workspace.
 *
 * All steps are best-effort — failures in backend POST or registry write
 * are logged as warnings, not thrown.
 */
export async function persistHostingUrl(
  options: PersistHostingUrlOptions
): Promise<void> {
  const { mode, writeWarning } = options;
  const resolvedMode = mode ?? resolveOutputMode({ json: false });
  warnAboutLegacyMigrations(options.projectRoot);
  const result = await persistHostingUrlState(options);

  if (result.redirectUriUpdated) {
    modeLog(resolvedMode, '✔ Hosting URL added to allowed redirect URIs');
  }
  if (result.configUpdated) {
    modeLog(resolvedMode, '✅ Updated rayfin.yml configuration');
  }
  if (result.workspaceKey && result.workspaceKey !== options.workspaceName) {
    modeLog(
      resolvedMode,
      `ℹ️  Workspace name sanitized: "${options.workspaceName}" → "${result.workspaceKey}"`
    );
  }
  if (result.envBackup) {
    for (const line of envBackupNoticeLines(result.envBackup)) {
      modeWarn(resolvedMode, line);
    }
  }
  for (const warning of result.warnings) {
    if (writeWarning) {
      writeWarning(`${warning}\n`);
    } else {
      modeWarn(
        resolvedMode === 'silent' ? 'interactive' : resolvedMode,
        warning
      );
    }
  }
}

/** Persist a hosting URL and return facts without rendering output. */
export async function persistHostingUrlState(
  options: Omit<PersistHostingUrlOptions, 'mode' | 'writeWarning'>
): Promise<HostingUrlPersistenceResult> {
  const { hostingUrl, services, projectRoot, workspaceName, postSettings } =
    options;
  const warnings: string[] = [];
  let configUpdated = false;
  let redirectUriUpdated = false;
  let workspaceKey: string | undefined;
  let envBackup: HostingUrlPersistenceResult['envBackup'];

  const baseOrigin = new URL(hostingUrl).origin;

  // Always add the bare origin: Fabric / Power BI embedded experiences need
  // it for the postMessage handoff regardless of whether interactive auth
  // is enabled. This is a temporary workaround until the backend
  // can automatically add the hosting URL to allowedRedirectUris. ETA: 2026-06-15.
  const updatedServices = addAllowedRedirectUri(services, baseOrigin);

  if (updatedServices !== services) {
    // POST to backend (best-effort)
    if (postSettings) {
      try {
        await postSettings(updatedServices);
        redirectUriUpdated = true;
      } catch (error) {
        warnings.push(
          `Could not update redirect URIs: ${(error as Error).message}\n` +
            `💡 Manually add "${baseOrigin}" to auth.allowedRedirectUris in rayfin.yml and re-run rayfin up`
        );
      }
    }

    // Persist updated services (allowedRedirectUris) to rayfin.yml
    const configResult = writeRayfinConfigUpdates(
      { services: updatedServices },
      projectRoot
    );
    configUpdated = configResult.status === 'updated';
    if (configResult.status === 'failed') {
      warnings.push(configResult.error);
    }
  }

  // Write hosting URL to deployment registry
  try {
    const existing = readDeploymentEnvFileState(projectRoot, workspaceName);
    warnings.push(...existing.warnings);
    if (existing.deployment) {
      const persistence = await persistDeploymentEnvFile(
        projectRoot,
        workspaceName,
        {
          ...existing.deployment,
          hostingUrl,
        }
      );
      workspaceKey = persistence.workspaceKey;
      envBackup = persistence.backup;
      warnings.push(...persistence.warnings);
    }
  } catch (error) {
    warnings.push(
      `Could not record the static hosting URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    configUpdated,
    redirectUriUpdated,
    workspaceKey,
    envBackup,
    warnings,
  };
}
