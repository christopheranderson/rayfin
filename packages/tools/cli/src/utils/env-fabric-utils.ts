/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deployment metadata helpers backed by the registry at
 * `rayfin/.deployments.json`.
 *
 * Historically this module wrote per-workspace `.env.fabric-*` files at the
 * project root; as of env-strategy v2 deployment metadata is persisted to a
 * single JSON registry and the matching `RAYFIN_PUBLIC_*` values are merged
 * into `rayfin/.env`. The function signatures and types here are preserved
 * to minimise churn in call sites (`up`, `up-status`, `up-staticapp`,
 * `up-db`, `hosting-url-utils`, `remote-endpoint-utils`, etc.).
 */

import { join, resolve } from 'path';

import inquirer from 'inquirer';

import {
  deploymentToPublicEnv,
  getActiveDeployment,
  getDeployment,
  getDeploymentState,
  listDeployments,
  sanitizeWorkspaceName as sanitize,
  upsertDeployment,
  upsertDeploymentState,
  type DeploymentRecord,
} from './deployments-registry.js';
import {
  envBackupNoticeLines,
  replaceDeploymentEnvInFileState,
} from './env-file-utils.js';
import { warnAboutLegacyMigrations } from './migration-utils.js';

/**
 * Typed deployment variables used by CLI call sites. Shape is preserved
 * from the pre-v2 implementation; field names still use the historic
 * `fabric*`/`rayfin*` mix.
 */
export interface DeploymentEnvVars {
  rayfinItemId: string;
  rayfinItemName?: string;
  rayfinApiUrl?: string;
  fabricWorkspaceId: string;
  /**
   * Entra ID tenant the workspace belongs to. Persisted to
   * `.deployments.json` so the CLI can target the correct authority when the
   * user has access to multiple tenants. Not exposed to the frontend.
   */
  fabricTenantId?: string;
  publishableKey?: string;
  fabricPortalUrl?: string;
  hostingUrl?: string;
}

/**
 * Result of listing deployments.
 */
export interface EnvFabricFileInfo {
  workspaceName: string;
}

/** Facts produced by an output-free deployment persistence operation. */
export interface DeploymentEnvPersistenceResult {
  path: string;
  workspaceKey: string;
  backup?: { sourcePath: string; backupPath: string };
  warnings: string[];
}

/** Output-free deployment lookup result. */
export interface DeploymentEnvReadResult {
  deployment: DeploymentEnvVars | null;
  warnings: string[];
}

// ── Workspace name sanitization ────────────────────────────────────────

/** Re-export for consumers that previously imported from this module. */
export const sanitizeWorkspaceName = sanitize;
// ── Stale-file detection ───────────────────────────────────────────────

/**
 * Delegate to the consolidated migration warning so call sites here and in
 * `rayfin dev` emit the same guidance.
 *
 * @deprecated Prefer importing {@link warnAboutLegacyMigrations} directly.
 */
function warnIfStaleEnvFabricFiles(projectRoot: string): void {
  warnAboutLegacyMigrations(projectRoot);
}

// ── Conversions ────────────────────────────────────────────────────────

function toRecord(vars: DeploymentEnvVars): DeploymentRecord {
  return {
    itemId: vars.rayfinItemId,
    itemName: vars.rayfinItemName,
    apiUrl: vars.rayfinApiUrl ?? '',
    workspaceId: vars.fabricWorkspaceId,
    tenantId: vars.fabricTenantId,
    publishableKey: vars.publishableKey,
    portalUrl: vars.fabricPortalUrl,
    hostingUrl: vars.hostingUrl,
  };
}

function fromRecord(record: DeploymentRecord): DeploymentEnvVars {
  return {
    rayfinItemId: record.itemId,
    rayfinItemName: record.itemName,
    rayfinApiUrl: record.apiUrl,
    fabricWorkspaceId: record.workspaceId,
    fabricTenantId: record.tenantId,
    publishableKey: record.publishableKey,
    fabricPortalUrl: record.portalUrl,
    hostingUrl: record.hostingUrl,
  };
}

// ── Read / Write ───────────────────────────────────────────────────────

/**
 * Persist deployment metadata: upserts the registry record and merges
 * the matching `RAYFIN_PUBLIC_*` variables into `rayfin/.env`. The active
 * deployment pointer is moved to this workspace.
 *
 * @returns A synthetic "path" string kept for message-formatting call sites.
 */
export async function writeDeploymentEnvFile(
  projectRoot: string,
  workspaceName: string,
  vars: DeploymentEnvVars
): Promise<string> {
  warnIfStaleEnvFabricFiles(projectRoot);

  const result = await persistDeploymentEnvFile(
    projectRoot,
    workspaceName,
    vars
  );
  for (const warning of result.warnings) {
    console.warn(`⚠️  ${warning}`);
  }
  if (result.workspaceKey !== workspaceName) {
    console.log(
      `ℹ️  Workspace name sanitized: "${workspaceName}" → "${result.workspaceKey}"`
    );
  }
  if (result.backup) {
    for (const line of envBackupNoticeLines(result.backup)) {
      console.warn(line);
    }
  }

  return result.path;
}

/** Persist deployment state without emitting user-facing output. */
export async function persistDeploymentEnvFile(
  projectRoot: string,
  workspaceName: string,
  vars: DeploymentEnvVars
): Promise<DeploymentEnvPersistenceResult> {
  const record = toRecord(vars);
  const registryWrite = upsertDeploymentState(
    projectRoot,
    workspaceName,
    record,
    { setActive: true }
  );

  // Mirror `RAYFIN_PUBLIC_*` values into rayfin/.env so rayfin.yml
  // interpolation and `rayfin env` pick them up. Stale deployment-derived
  // keys from a previously-active deployment are cleared first so they
  // don't survive a `rayfin up <other-workspace>` or `up switch`.
  // `hostingUrl` is registry-only per RFC and is intentionally not merged.
  const rayfinDir = join(projectRoot, 'rayfin');
  const envWrite = await replaceDeploymentEnvInFileState(
    rayfinDir,
    deploymentToPublicEnv(record)
  );

  return {
    path: resolve(projectRoot, 'rayfin', '.deployments.json'),
    workspaceKey: registryWrite.workspaceKey,
    backup: envWrite.backup,
    warnings: registryWrite.warnings,
  };
}

/**
 * Look up a deployment by workspace name. Returns `null` when absent.
 */
export function readDeploymentEnvFile(
  projectRoot: string,
  workspaceName: string
): DeploymentEnvVars | null {
  const record = getDeployment(projectRoot, workspaceName);
  return record ? fromRecord(record) : null;
}

/** Read deployment state without rendering registry parse warnings. */
export function readDeploymentEnvFileState(
  projectRoot: string,
  workspaceName: string
): DeploymentEnvReadResult {
  const result = getDeploymentState(projectRoot, workspaceName);
  return {
    deployment: result.record ? fromRecord(result.record) : null,
    warnings: result.warnings,
  };
}

// ── Scanning ───────────────────────────────────────────────────────────

/**
 * List every deployment in the registry, returned in the legacy
 * `EnvFabricFileInfo` shape expected by call sites.
 *
 * @deprecated Prefer importing from `deployments-registry.ts` directly.
 */
export function findExistingEnvFabricFiles(
  projectRoot: string
): EnvFabricFileInfo[] {
  warnIfStaleEnvFabricFiles(projectRoot);
  return listDeployments(projectRoot).map(({ workspaceName }) => ({
    workspaceName,
  }));
}

// ── Pre-seeding (used by `rayfin init --item-id --workspace-id`) ────

/**
 * Pre-seed a minimal deployment record with only item ID and workspace ID.
 * Used by `rayfin init` when the user provides `--item-id` / `--workspace-id`
 * to associate a project with a Fabric workspace before running `rayfin up`.
 *
 * Does not overwrite an existing deployment that already has an API URL
 * (i.e. a full deployment from `rayfin up`).
 *
 * @param projectRoot - The Rayfin project root.
 * @param vars - Item ID and workspace ID to seed.
 * @param workspaceName - Optional registry key (defaults to `'default'` for
 *                       back-compat). Pass the project name to key the
 *                       deployment by sanitized project slug.
 * @returns `true` if the record was written, `false` if skipped.
 */
export function preSeedDeploymentEnvFile(
  projectRoot: string,
  vars: {
    fabricItemId?: string;
    fabricWorkspaceId?: string;
  },
  workspaceName = 'default'
): boolean {
  if (!vars.fabricWorkspaceId) {
    return false;
  }

  // Don't overwrite a full deployment that already has an API URL.
  const active = getActiveDeployment(projectRoot);
  if (active && active.record.apiUrl) {
    return false;
  }

  upsertDeployment(
    projectRoot,
    workspaceName,
    {
      itemId: vars.fabricItemId ?? '',
      apiUrl: '',
      workspaceId: vars.fabricWorkspaceId,
    },
    { setActive: true }
  );
  return true;
}

// ── Resolution helpers ─────────────────────────────────────────────────

export interface ResolveDeploymentOptions {
  projectRoot: string;
  /** Look for a specific workspace. Skips interactive selection. */
  workspaceName?: string;
  /** Suppress prompts and return the active (or first) deployment. */
  nonInteractive?: boolean;
}

export interface ResolvedDeployment {
  workspaceName: string;
  deployment: DeploymentEnvVars;
}

/**
 * Resolve a single deployment from the registry.
 *
 * Selection logic:
 * 1. Specific `workspaceName` → look it up.
 * 2. Otherwise, if an active deployment is set → use it.
 * 3. Otherwise, if exactly one deployment exists → use it.
 * 4. Multiple, interactive → prompt the user.
 * 5. Multiple, non-interactive → use the first registered deployment.
 * 6. Empty registry → `null`.
 */
export async function resolveDeploymentEnvFile(
  options: ResolveDeploymentOptions
): Promise<ResolvedDeployment | null> {
  const { projectRoot, workspaceName, nonInteractive = false } = options;

  if (workspaceName) {
    const record = getDeployment(projectRoot, workspaceName);
    if (!record) return null;
    return {
      workspaceName: sanitizeWorkspaceName(workspaceName),
      deployment: fromRecord(record),
    };
  }

  const active = getActiveDeployment(projectRoot);
  if (active) {
    return {
      workspaceName: active.workspaceName,
      deployment: fromRecord(active.record),
    };
  }

  const all = listDeployments(projectRoot);
  if (all.length === 0) return null;
  if (all.length === 1) {
    return {
      workspaceName: all[0].workspaceName,
      deployment: fromRecord(all[0].record),
    };
  }

  if (nonInteractive) {
    return {
      workspaceName: all[0].workspaceName,
      deployment: fromRecord(all[0].record),
    };
  }

  const { chosen } = await inquirer.prompt<{ chosen: string }>([
    {
      type: 'list',
      name: 'chosen',
      message: 'Multiple Fabric workspace deployments found. Which one?',
      choices: all.map((d) => ({
        name: d.workspaceName,
        value: d.workspaceName,
      })),
    },
  ]);
  const record = getDeployment(projectRoot, chosen);
  if (!record) return null;
  return { workspaceName: chosen, deployment: fromRecord(record) };
}
