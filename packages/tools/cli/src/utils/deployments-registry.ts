/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Multi-deployment registry persisted to `rayfin/.deployments.json`.
 *
 * Replaces the per-workspace `.env.fabric-*` files that used to live at the
 * project root. The registry keeps all workspace deployments in a single
 * JSON file and tracks which one is currently "active" — the one whose
 * `RAYFIN_PUBLIC_*` values populate `rayfin/.env`.
 *
 * File shape (see docs/rfc/env-file-strategy.md):
 *
 * ```json
 * {
 *   "active": "my-workspace",
 *   "deployments": {
 *     "my-workspace": {
 *       "itemId": "…",
 *       "apiUrl": "…",
 *       "workspaceId": "…",
 *       "tenantId": "…",
 *       "publishableKey": "…",
 *       "portalUrl": "…",
 *       "hostingUrl": "…",
 *       "deployedAt": "2026-…"
 *     }
 *   }
 * }
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import {
  type DeploymentsRegistry,
  composeFabricItemDeepLink,
  deploymentInfoToPublicEnv,
  extractPortalUrl,
  sanitizeWorkspaceName,
} from '@microsoft/rayfin-tools-common/_internal/config';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * A single deployment record stored in `.deployments.json`.
 *
 * Field names intentionally drop the `fabric*` prefix used by the legacy
 * `.env.fabric-*` format — the registry is storage-format-agnostic.
 */
export interface DeploymentRecord {
  itemId: string;
  itemName?: string;
  apiUrl: string;
  workspaceId: string;
  /**
   * Entra ID tenant the workspace belongs to. Required to disambiguate when
   * the user has access to multiple tenants — without it the CLI cannot tell
   * which authority to call when switching deployments.
   */
  tenantId?: string;
  publishableKey?: string;
  portalUrl?: string;
  hostingUrl?: string;
  /** ISO-8601 timestamp of the most recent `rayfin up` for this workspace. */
  deployedAt?: string;
}

/** Re-export for consumers importing from this module. */
export { sanitizeWorkspaceName };
export type { DeploymentsRegistry };

// ── Path ───────────────────────────────────────────────────────────────

const REGISTRY_FILENAME = '.deployments.json';

/** Absolute path to `rayfin/.deployments.json` under a project root. */
export function getDeploymentsRegistryPath(projectRoot: string): string {
  return resolve(projectRoot, 'rayfin', REGISTRY_FILENAME);
}

export { deploymentInfoToPublicEnv, extractPortalUrl };

/** Output-free registry read result. */
export interface DeploymentsRegistryReadResult {
  registry: DeploymentsRegistry;
  warnings: string[];
}

// ── Workspace name sanitization ────────────────────────────────────────

// ── Read / Write ───────────────────────────────────────────────────────

/**
 * Read the deployments registry from disk.
 *
 * Returns an empty registry (`{ deployments: {} }`) when the file does not
 * exist or cannot be parsed — deployment lookup is a best-effort operation.
 */
export function readDeploymentsRegistry(
  projectRoot: string
): DeploymentsRegistry {
  const result = readDeploymentsRegistryState(projectRoot);
  for (const warning of result.warnings) {
    console.warn(`⚠️  ${warning}`);
  }
  return result.registry;
}

/** Read the registry and return parse advisories without rendering. */
export function readDeploymentsRegistryState(
  projectRoot: string
): DeploymentsRegistryReadResult {
  const path = getDeploymentsRegistryPath(projectRoot);
  if (!existsSync(path)) {
    return { registry: { deployments: {} }, warnings: [] };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as DeploymentsRegistry;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.deployments !== 'object' ||
      parsed.deployments === null
    ) {
      return { registry: { deployments: {} }, warnings: [] };
    }
    return { registry: parsed, warnings: [] };
  } catch (error) {
    return {
      registry: { deployments: {} },
      warnings: [
        `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}. Starting with an empty registry.`,
      ],
    };
  }
}

/**
 * Write the deployments registry to disk. Creates `rayfin/` if missing.
 */
export function writeDeploymentsRegistry(
  projectRoot: string,
  registry: DeploymentsRegistry
): void {
  const path = getDeploymentsRegistryPath(projectRoot);
  const dir = resolve(projectRoot, 'rayfin');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

// ── Mutations ──────────────────────────────────────────────────────────

/**
 * Compose the canonical Fabric deep link from a deployment record.
 *
 * Thin wrapper over the shared {@link composeFabricItemDeepLink} helper that
 * returns `undefined` when the record is missing required fields (the helper
 * itself assumes its inputs are present).
 */
function composeFabricDeepLink(record: DeploymentRecord): string | undefined {
  if (!record.portalUrl || !record.workspaceId || !record.itemId) {
    return undefined;
  }
  return composeFabricItemDeepLink(
    record.portalUrl,
    record.workspaceId,
    record.itemId,
    record.tenantId
  );
}

/**
 * Insert or replace a deployment record under its sanitized workspace key.
 * Sets the active pointer to the same key.
 *
 * @returns The sanitized workspace key that was written.
 */
export function upsertDeployment(
  projectRoot: string,
  workspaceName: string,
  record: DeploymentRecord,
  options: { setActive?: boolean } = {}
): string {
  const result = upsertDeploymentState(
    projectRoot,
    workspaceName,
    record,
    options
  );
  for (const warning of result.warnings) {
    console.warn(`⚠️  ${warning}`);
  }
  return result.workspaceKey;
}

/** Upsert a deployment and return parse advisories without rendering. */
export function upsertDeploymentState(
  projectRoot: string,
  workspaceName: string,
  record: DeploymentRecord,
  options: { setActive?: boolean } = {}
): { workspaceKey: string; warnings: string[] } {
  const { setActive = true } = options;
  const key = sanitizeWorkspaceName(workspaceName);
  const readResult = readDeploymentsRegistryState(projectRoot);
  const registry = readResult.registry;
  registry.deployments[key] = {
    fabricItemId: record.itemId,
    itemName: record.itemName,
    fabricApiUrl: record.apiUrl,
    fabricWorkspaceId: record.workspaceId,
    fabricTenantId: record.tenantId,
    publishableKey: record.publishableKey,
    hostingUrl: record.hostingUrl,
    fabricDeepLink: composeFabricDeepLink(record),
    deployedAt: record.deployedAt ?? new Date().toISOString(),
  };
  if (setActive) {
    registry.active = key;
  }
  writeDeploymentsRegistry(projectRoot, registry);
  return { workspaceKey: key, warnings: readResult.warnings };
}

/**
 * Retrieve a single deployment record by sanitized key, translated into the
 * `DeploymentRecord` shape used by CLI callers.
 */
export function getDeployment(
  projectRoot: string,
  workspaceName: string
): DeploymentRecord | null {
  const result = getDeploymentState(projectRoot, workspaceName);
  for (const warning of result.warnings) {
    console.warn(`⚠️  ${warning}`);
  }
  return result.record;
}

/** Read one deployment and return parse advisories without rendering. */
export function getDeploymentState(
  projectRoot: string,
  workspaceName: string
): { record: DeploymentRecord | null; warnings: string[] } {
  const key = sanitizeWorkspaceName(workspaceName);
  const readResult = readDeploymentsRegistryState(projectRoot);
  const registry = readResult.registry;
  const info = registry.deployments[key];
  if (!info || info.fabricItemId == null || !info.fabricWorkspaceId) {
    return { record: null, warnings: readResult.warnings };
  }
  return {
    record: {
      itemId: info.fabricItemId,
      itemName: info.itemName,
      apiUrl: info.fabricApiUrl ?? '',
      workspaceId: info.fabricWorkspaceId,
      tenantId: info.fabricTenantId,
      publishableKey: info.publishableKey,
      portalUrl: extractPortalUrl(info.fabricDeepLink, info.fabricWorkspaceId),
      hostingUrl: info.hostingUrl,
      deployedAt: info.deployedAt,
    },
    warnings: readResult.warnings,
  };
}

/** Get the active deployment record, or null if none is selected. */
export function getActiveDeployment(
  projectRoot: string
): { workspaceName: string; record: DeploymentRecord } | null {
  const registry = readDeploymentsRegistry(projectRoot);
  if (!registry.active) return null;
  const record = getDeployment(projectRoot, registry.active);
  if (!record) return null;
  return { workspaceName: registry.active, record };
}

/**
 * Whether a record describes a Rayfin item that has actually been deployed.
 *
 * A record's presence is not sufficient. `rayfin init --workspace-id` pre-seeds
 * an active record to remember which workspace the project targets, before any
 * deploy has happened; that placeholder carries an empty `itemId`/`apiUrl`
 * (see `preSeedDeploymentEnvFile`). Callers that need a live item must ask this
 * rather than testing only for the record's existence, otherwise the
 * pre-seeded placeholder reads as a deployment and the caller fails later with
 * a message about the missing field instead of the real cause: `rayfin up` has
 * not been run yet.
 */
export function isDeployedRecord(
  record: Pick<DeploymentRecord, 'itemId' | 'apiUrl'> | undefined
): boolean {
  return Boolean(record?.itemId && record.apiUrl);
}

/**
 * List every deployment in the registry along with its active flag.
 */
export function listDeployments(
  projectRoot: string
): Array<{ workspaceName: string; record: DeploymentRecord; active: boolean }> {
  const result = listDeploymentsState(projectRoot);
  for (const warning of result.warnings) {
    console.warn(`⚠️  ${warning}`);
  }
  return result.deployments;
}

/** List deployments and return parse advisories without rendering. */
export function listDeploymentsState(projectRoot: string): {
  deployments: Array<{
    workspaceName: string;
    record: DeploymentRecord;
    active: boolean;
  }>;
  warnings: string[];
} {
  const readResult = readDeploymentsRegistryState(projectRoot);
  const registry = readResult.registry;
  const out: Array<{
    workspaceName: string;
    record: DeploymentRecord;
    active: boolean;
  }> = [];
  for (const [key] of Object.entries(registry.deployments)) {
    const info = registry.deployments[key];
    if (!info || !info.fabricItemId || !info.fabricWorkspaceId) continue;
    out.push({
      workspaceName: key,
      record: {
        itemId: info.fabricItemId,
        itemName: info.itemName,
        apiUrl: info.fabricApiUrl ?? '',
        workspaceId: info.fabricWorkspaceId,
        tenantId: info.fabricTenantId,
        publishableKey: info.publishableKey,
        portalUrl: extractPortalUrl(
          info.fabricDeepLink,
          info.fabricWorkspaceId
        ),
        hostingUrl: info.hostingUrl,
        deployedAt: info.deployedAt,
      },
      active: registry.active === key,
    });
  }
  return { deployments: out, warnings: readResult.warnings };
}

/**
 * Set a workspace as active. Returns `true` on success, `false` if the
 * workspace is not in the registry.
 */
export function setActiveDeployment(
  projectRoot: string,
  workspaceName: string
): boolean {
  const key = sanitizeWorkspaceName(workspaceName);
  const registry = readDeploymentsRegistry(projectRoot);
  if (!registry.deployments[key]) {
    return false;
  }
  registry.active = key;
  writeDeploymentsRegistry(projectRoot, registry);
  return true;
}

// ── Public-env projection ──────────────────────────────────────────────

/**
 * Convert a CLI {@link DeploymentRecord} into the `RAYFIN_PUBLIC_*`
 * variables via the shared {@link deploymentInfoToPublicEnv}.
 */
export function deploymentToPublicEnv(
  record: DeploymentRecord
): Map<string, string> {
  return deploymentInfoToPublicEnv({
    fabricItemId: record.itemId,
    fabricApiUrl: record.apiUrl,
    fabricWorkspaceId: record.workspaceId,
    fabricTenantId: record.tenantId,
    publishableKey: record.publishableKey,
    fabricDeepLink: composeFabricDeepLink(record),
    hostingUrl: record.hostingUrl,
  });
}
