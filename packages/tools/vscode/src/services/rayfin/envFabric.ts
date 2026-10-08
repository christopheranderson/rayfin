/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deployment metadata helpers backed by `rayfin/.deployments.json` and
 * mirrored into `rayfin/.env`.
 *
 * Web-safe: uses `vscode.workspace.fs` and the shared parser from
 * `@microsoft/rayfin-tools-common` — no `node:fs` imports.
 *
 * As of env-strategy v2 this module no longer writes legacy
 * `.env.fabric-*` files. Function signatures are preserved so call sites
 * (`commands/up`, `commands/upStaticDeploy`, `commands/createProject`,
 * `webviews/projectView/projectViewRouter`) don't need deep changes.
 */

import {
  type DeploymentInfo,
  type DeploymentsRegistry,
  clearDeploymentPublicEnv,
  deploymentInfoToPublicEnv,
  mergeEnvVars,
  parseEnvContent,
  sanitizeWorkspaceName,
  serializeEnvContent,
} from '@microsoft/rayfin-tools-common/_internal/config';
import * as vscode from 'vscode';

import { ext } from '../../extensionVariables';

const REGISTRY_PATH = ['rayfin', '.deployments.json'];
const ENV_FILE_PATH = ['rayfin', '.env'];

/**
 * First line written by env-strategy v2 in any auto-managed `.env` file.
 * Used to detect v1-vintage files before the first rewrite.
 */
const V2_HEADER_SENTINEL = '# Rayfin environment configuration';

const LEGACY_ENV_FABRIC_PREFIX = '.env.fabric-';
const LEGACY_ENV_FABRIC_STATIC = '.env.fabric';
const LEGACY_TEMP_ENV_PATH = ['rayfin', '.temp', '.env'];

/**
 * Deployment variables. Shape preserved from pre-v2 for API compatibility.
 */
export interface DeploymentEnvVars {
  fabricItemId?: string;
  rayfinApiUrl?: string;
  fabricWorkspaceId?: string;
  /**
   * Entra ID tenant the workspace belongs to. Persisted to
   * `.deployments.json` so the CLI/extension can target the correct
   * authority when the user has access to multiple tenants.
   */
  fabricTenantId?: string;
  publishableKey?: string;
  fabricPortalUrl?: string;
  hostingUrl?: string;
}

/**
 * Result shape expected by callers that iterate the registry as if it
 * were a list of `.env.fabric-*` files.
 */
export interface EnvFabricFileInfo {
  workspaceName: string;
  uri: vscode.Uri;
}

// ── Workspace name sanitization ────────────────────────────────────────

// Re-export for call sites that import from this module.
export { sanitizeWorkspaceName };

/**
 * Extract the Entra ID tenant ID (`tid` claim) from a Fabric/Entra
 * access token. Returns `undefined` when the token is not a valid JWT or
 * the `tid` claim is missing.
 *
 * This is a **non-validating** decode — we only need the claim value for
 * persisting alongside the deployment record, not for security decisions.
 */
export function extractTenantIdFromToken(
  accessToken: string
): string | undefined {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(globalThis.atob(parts[1])) as {
      tid?: string;
    };
    return typeof payload.tid === 'string' ? payload.tid : undefined;
  } catch {
    return undefined;
  }
}

// ── Registry I/O ───────────────────────────────────────────────────────

function registryUri(projectRootUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(projectRootUri, ...REGISTRY_PATH);
}

function envFileUri(projectRootUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(projectRootUri, ...ENV_FILE_PATH);
}

async function readRegistry(
  projectRootUri: vscode.Uri
): Promise<DeploymentsRegistry> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      registryUri(projectRootUri)
    );
    const parsed = JSON.parse(
      new TextDecoder().decode(bytes)
    ) as DeploymentsRegistry;
    if (!parsed || typeof parsed !== 'object' || !parsed.deployments) {
      return { deployments: {} };
    }
    return parsed;
  } catch {
    return { deployments: {} };
  }
}

async function writeRegistry(
  projectRootUri: vscode.Uri,
  registry: DeploymentsRegistry
): Promise<void> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(registry, null, 2) + '\n'
  );
  await vscode.workspace.fs.writeFile(registryUri(projectRootUri), bytes);
}

// ── rayfin/.env helpers ────────────────────────────────────────────────

async function readEnvMap(
  projectRootUri: vscode.Uri
): Promise<Map<string, string>> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      envFileUri(projectRootUri)
    );
    return parseEnvContent(new TextDecoder().decode(bytes));
  } catch {
    return new Map();
  }
}

async function writeEnvMap(
  projectRootUri: vscode.Uri,
  vars: Map<string, string>
): Promise<void> {
  const uri = envFileUri(projectRootUri);
  await backupV1EnvFileIfNeeded(uri);
  const header = [
    'Rayfin environment configuration',
    'Auto-managed by `rayfin up` and the VS Code extension — safe to hand-edit.',
  ];
  const content = serializeEnvContent(vars, header);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

// ── v1 → v2 migration helpers ──────────────────────────────────────────

let backupEmitted = false;

/**
 * Back up a v1-vintage `rayfin/.env` to `rayfin/.env.bak` before the first
 * v2 rewrite. The serializer drops comments and re-orders keys so a one-shot
 * backup gives users a recovery path for hand-curated content.
 */
async function backupV1EnvFileIfNeeded(envUri: vscode.Uri): Promise<void> {
  let existing: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(envUri);
    existing = new TextDecoder().decode(bytes);
  } catch {
    return; // file doesn't exist
  }
  if (existing.length === 0) return;
  if (existing.startsWith(V2_HEADER_SENTINEL)) return;

  const backupUri = vscode.Uri.parse(`${envUri.toString()}.bak`);
  try {
    await vscode.workspace.fs.stat(backupUri);
    return; // backup already exists — don't clobber
  } catch {
    // absent, proceed
  }

  await vscode.workspace.fs.writeFile(
    backupUri,
    new TextEncoder().encode(existing)
  );
  if (!backupEmitted) {
    backupEmitted = true;
    ext.outputChannel.appendLine(
      `ℹ️  Backed up your previous rayfin/.env to rayfin/.env.bak before rewriting in env-strategy v2 format.`
    );
    ext.outputChannel.appendLine(
      '   Variable values are preserved; comments and ordering are not. Diff the two files to recover any custom content.'
    );
  }
}

let migrationWarningEmitted = false;

/**
 * Detect env-strategy v1 artifacts and surface actionable migration guidance
 * in the output channel + a one-shot notification. Idempotent per session.
 */
export async function warnAboutLegacyMigrations(
  projectRootUri: vscode.Uri
): Promise<void> {
  if (migrationWarningEmitted) return;
  migrationWarningEmitted = true;

  const fabricFiles = await findLegacyEnvFabricFiles(projectRootUri);
  const hasTempEnv = await hasLegacyTempEnvFile(projectRootUri);

  if (fabricFiles.length === 0 && !hasTempEnv) return;

  const lines: string[] = [
    '⚠️  Detected env-strategy v1 artifacts. The Rayfin extension no longer reads',
    '   these files. Follow the steps below so your project keeps working.',
    '   See docs/rfc/env-file-strategy.md for background.',
  ];

  if (fabricFiles.length > 0) {
    lines.push('');
    lines.push(
      `   1) Legacy deployment files at project root: ${fabricFiles.join(', ')}`
    );
    lines.push(
      '      → Deployment metadata now lives in rayfin/.deployments.json.'
    );
    lines.push(
      '      → Run "Rayfin: Deploy to Fabric" again for each workspace to'
    );
    lines.push(
      '        repopulate the registry, then delete the legacy files.'
    );
  }

  if (hasTempEnv) {
    lines.push('');
    lines.push('   2) Legacy runtime env file: rayfin/.temp/.env');
    lines.push(
      '      → Runtime values (ports, generated postgres password) now live'
    );
    lines.push('        in rayfin/.env alongside deployment metadata.');
    lines.push(
      '      → If you have an existing local database volume that depends on'
    );
    lines.push(
      '        the generated RAYFIN_POSTGRES_PASSWORD, copy that value into'
    );
    lines.push(
      '        rayfin/.env before the next `rayfin dev` run, otherwise the DB'
    );
    lines.push(
      '        connection will fail with the newly generated password.'
    );
    lines.push(
      '      → Otherwise: safe to delete rayfin/.temp/.env (ports will be'
    );
    lines.push('        re-allocated automatically).');
  }

  for (const line of lines) {
    ext.outputChannel.appendLine(line);
  }

  void vscode.window
    .showWarningMessage(
      'Detected legacy .env files from a previous Rayfin CLI version. See the Rayfin output channel for migration steps.',
      'Show Details'
    )
    .then((choice) => {
      if (choice === 'Show Details') {
        ext.outputChannel.show(true);
      }
    });
}

async function findLegacyEnvFabricFiles(
  projectRootUri: vscode.Uri
): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(projectRootUri);
    return entries
      .filter(
        ([name, type]) =>
          type === vscode.FileType.File &&
          (name === LEGACY_ENV_FABRIC_STATIC ||
            name.startsWith(LEGACY_ENV_FABRIC_PREFIX))
      )
      .map(([name]) => name);
  } catch {
    return [];
  }
}

async function hasLegacyTempEnvFile(
  projectRootUri: vscode.Uri
): Promise<boolean> {
  try {
    const uri = vscode.Uri.joinPath(projectRootUri, ...LEGACY_TEMP_ENV_PATH);
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.File;
  } catch {
    return false;
  }
}

// ── Read / Write ───────────────────────────────────────────────────────

/**
 * Upsert the deployment record into `rayfin/.deployments.json` and mirror
 * its `RAYFIN_PUBLIC_*` values into `rayfin/.env`. Marks the record active.
 *
 * @throws If `workspaceName` is not provided — callers must always resolve
 *         the workspace display name before writing a deployment record.
 */
export async function writeDeploymentEnvFile(
  projectRootUri: vscode.Uri,
  workspaceName: string,
  vars: DeploymentEnvVars
): Promise<void> {
  const registry = await readRegistry(projectRootUri);
  const slug = sanitizeWorkspaceName(workspaceName);

  const info: DeploymentInfo = {
    fabricItemId: vars.fabricItemId,
    fabricApiUrl: vars.rayfinApiUrl,
    fabricWorkspaceId: vars.fabricWorkspaceId,
    fabricTenantId: vars.fabricTenantId,
    fabricDeepLink:
      vars.fabricPortalUrl && vars.fabricWorkspaceId && vars.fabricItemId
        ? `${vars.fabricPortalUrl}/groups/${vars.fabricWorkspaceId}/appbackends/${vars.fabricItemId}`
        : undefined,
    publishableKey: vars.publishableKey,
    hostingUrl: vars.hostingUrl,
    deployedAt: new Date().toISOString(),
  };

  registry.deployments[slug] = info;
  registry.active = slug;
  await writeRegistry(projectRootUri, registry);

  // Mirror RAYFIN_PUBLIC_* into rayfin/.env for rayfin.yml interpolation
  // and `rayfin env`. Stale deployment-derived keys are cleared first so
  // values from a previously-active deployment don't leak through.
  const existing = await readEnvMap(projectRootUri);
  const cleared = clearDeploymentPublicEnv(existing);
  const merged = mergeEnvVars(cleared, deploymentInfoToPublicEnv(info));
  await writeEnvMap(projectRootUri, merged);

  ext.outputChannel.appendLine(
    `Updated rayfin/.deployments.json (active: ${slug}) and rayfin/.env`
  );
}

/**
 * Look up a deployment by workspace name. Returns `null` when absent.
 */
export async function readDeploymentEnvFile(
  projectRootUri: vscode.Uri,
  workspaceName: string
): Promise<DeploymentInfo | null> {
  const registry = await readRegistry(projectRootUri);
  const slug = sanitizeWorkspaceName(workspaceName);
  const info = registry.deployments[slug];
  if (!info || !info.fabricItemId || !info.fabricWorkspaceId) {
    return null;
  }
  return info;
}

// ── Scanning ───────────────────────────────────────────────────────────

/**
 * List every deployment in the registry, in the legacy
 * `EnvFabricFileInfo` shape (`uri` points at the registry file — callers
 * that need per-deployment paths should switch to reading the registry).
 */
export async function findExistingEnvFabricFiles(
  projectRootUri: vscode.Uri
): Promise<EnvFabricFileInfo[]> {
  const registry = await readRegistry(projectRootUri);
  const regUri = registryUri(projectRootUri);
  return Object.keys(registry.deployments).map((workspaceName) => ({
    workspaceName,
    uri: regUri,
  }));
}

/**
 * Return the active deployment, falling back to the single registered
 * deployment if the `active` pointer is missing.
 */
export async function readLatestDeployment(
  projectRootUri: vscode.Uri
): Promise<{ deployment: DeploymentInfo } | null> {
  const registry = await readRegistry(projectRootUri);
  const keys = Object.keys(registry.deployments);
  if (keys.length === 0) return null;

  const activeKey =
    registry.active && registry.deployments[registry.active]
      ? registry.active
      : keys[0];
  const info = registry.deployments[activeKey];
  if (!info || !info.fabricItemId || !info.fabricWorkspaceId) {
    return null;
  }
  return { deployment: info };
}

/**
 * Resolve a single deployment via the registry, prompting the user when
 * there's ambiguity.
 *
 * Selection logic:
 * 1. No deployments → `null`.
 * 2. Active deployment set → use it.
 * 3. Exactly one deployment → use it.
 * 4. Multiple deployments → show a QuickPick.
 */
export async function resolveDeploymentFromEnvFiles(
  projectRootUri: vscode.Uri
): Promise<{ workspaceName: string; deployment: DeploymentInfo } | null> {
  const registry = await readRegistry(projectRootUri);
  const keys = Object.keys(registry.deployments);
  if (keys.length === 0) return null;

  const pick = (key: string) => {
    const info = registry.deployments[key];
    if (!info || !info.fabricItemId || !info.fabricWorkspaceId) return null;
    return { workspaceName: key, deployment: info };
  };

  if (registry.active && registry.deployments[registry.active]) {
    const r = pick(registry.active);
    if (r) return r;
  }

  if (keys.length === 1) {
    return pick(keys[0]);
  }

  const selected = await vscode.window.showQuickPick(
    keys.map((key) => ({
      label: key,
      key,
    })),
    {
      placeHolder: vscode.l10n.t(
        'Multiple deployments found — select a workspace'
      ),
      title: vscode.l10n.t('Existing Deployments'),
    }
  );

  if (!selected) return null;
  return pick(selected.key);
}
