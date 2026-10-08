/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Resolve a Fabric workspace **display name** to a workspace **ID** by
 * calling the Fabric REST API.
 *
 * Used by the `--workspace <name>` CLI flag (on `rayfin init`,
 * `create-rayfin`, `rayfin up`, and several `rayfin up` subcommands)
 * to give users a name-based alternative to `--workspace-id <guid>`.
 *
 * Auth resolution mirrors {@link hydrateDeploymentFromFabric}:
 *   1. Caller-supplied `token` (no auth needed).
 *   2. Ambient `RAYFIN_TOKEN`.
 *   3. Cached MSAL silent token from a prior `rayfin login`.
 *   4. If `interactive: true`, browser / device-code auth (loud).
 *
 * Matching rules (display name → ID):
 *   - Case-sensitive exact match wins.
 *   - Case-insensitive single match next.
 *   - Multiple case-insensitive matches throw with the candidate names so
 *     the user can disambiguate (typically by passing `--workspace-id`).
 *   - No match throws a short, user-actionable
 *     `Workspace "<name>" not found. Please retry with a valid workspace name.`
 *     line — same string regardless of whether the account has zero
 *     accessible workspaces or many. Per the PuPr PRD
 *     (`docs/prd/cli-create-up-behavior-pu-pr.md`), the intent is to
 *     send users to the Fabric portal to look up the right name rather
 *     than dump candidates into CLI error output.
 */

import { getRayfinAuth } from '../auth/index.js';
import type { FabricWorkspace } from '../services/fabric/workspace.js';
import { WorkspaceManager } from '../services/fabric/workspace.js';

import { hasAmbientToken, getAmbientToken } from './ambient-env.js';
import { normalizeForFuzzyMatch } from './normalize-name.js';

export interface ResolveWorkspaceOptions {
  /**
   * Pre-acquired Fabric bearer token. When provided, skips token
   * acquisition entirely. Pass this from commands that have already
   * called `ensureAuthenticated()` (e.g. `rayfin up`).
   */
  token?: string;
  /** Optional Entra ID tenant override for auth (matches `hydrate-deployment.ts`). */
  tenantId?: string;
  /**
   * When `true`, fall back to interactive (browser / device-code) auth if
   * no ambient token and no cached silent token are available. Callers
   * MUST only set this when stdin/stdout are a TTY.
   *
   * Defaults to `false` to preserve silent-only behavior in non-TTY
   * contexts (CI, agent, child-process invocations).
   */
  interactive?: boolean;
}

export interface ResolvedWorkspace {
  id: string;
  displayName: string;
}

/**
 * Acquire a Fabric token via the same resolution order used by
 * `hydrate-deployment.ts`. Throws with an actionable message on failure.
 *
 * Exported so callers that need to make a follow-up Fabric API call
 * after `resolveWorkspaceIdByName` (e.g. an AppBackend item lookup) can
 * reuse the same token acquisition path without re-prompting.
 */
export async function acquireFabricTokenForLookup(
  options: { tenantId?: string; interactive?: boolean } = {}
): Promise<string> {
  return acquireToken(options.tenantId, options.interactive ?? false);
}

async function acquireToken(
  _tenantId: string | undefined,
  interactive: boolean
): Promise<string> {
  if (hasAmbientToken()) {
    return getAmbientToken()!;
  }
  try {
    const auth = await getRayfinAuth();
    const result = await auth.acquireToken(undefined, {
      silentOnly: !interactive,
    });
    return result.token;
  } catch {
    if (interactive) {
      throw new Error(
        'Fabric authentication failed. Run `rayfin login`, then re-run this command.'
      );
    }
    throw new Error(
      'No cached Fabric session and stdin is not a TTY. Run `rayfin login` once on this machine, then re-run this command.'
    );
  }
}

/**
 * Acquire a token (if not already supplied) and list every workspace the
 * caller can see. Used by {@link resolveWorkspaceIdByNameFuzzy} so its
 * normalized fallback can reuse an already-fetched list instead of
 * re-hitting the Fabric API. {@link resolveWorkspaceIdByName} does its
 * own token/list acquisition inline and does not use this helper, so it
 * stays untouched by this optimization.
 */
async function fetchWorkspaceList(
  options: ResolveWorkspaceOptions
): Promise<FabricWorkspace[]> {
  const token =
    options.token ??
    (await acquireToken(options.tenantId, options.interactive ?? false));
  const workspaceManager = new WorkspaceManager(token);
  return workspaceManager.listWorkspaces();
}

/**
 * Resolve a Fabric workspace display name to its ID.
 *
 * @throws `Error` When the name does not match exactly one workspace or when
 *   authentication fails. Error messages are user-actionable and safe to
 *   surface directly via `modeError`.
 */
export async function resolveWorkspaceIdByName(
  name: string,
  options: ResolveWorkspaceOptions = {}
): Promise<ResolvedWorkspace> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('--workspace value is empty.');
  }

  const token =
    options.token ??
    (await acquireToken(options.tenantId, options.interactive ?? false));

  const workspaceManager = new WorkspaceManager(token);
  const workspaces = await workspaceManager.listWorkspaces();

  return resolveWorkspaceFromList(trimmed, workspaces);
}

/** Resolve a workspace name against an already-fetched workspace list. */
export function resolveWorkspaceFromList(
  name: string,
  workspaces: readonly ResolvedWorkspace[]
): ResolvedWorkspace {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('--workspace value is empty.');
  }
  return matchStrict(workspaces, trimmed);
}

const WORKSPACE_NOT_FOUND_SUFFIX =
  'not found. Please retry with a valid workspace name.';

/**
 * Like {@link resolveWorkspaceIdByName}, plus a normalized-match fallback
 * (ignores case/punctuation, e.g. "test-wk-1" == "test--wk1"). Kept
 * separate so `init`/`up` (write flows) can't silently target the wrong
 * workspace; only `connector inspect` uses this.
 *
 * Fetches the workspace list once and reuses the shared {@link matchStrict}
 * (same Pass 1/2 logic as {@link resolveWorkspaceIdByName}) against that
 * one list, so the normalized fallback doesn't need to re-list workspaces
 * on a miss.
 */
export async function resolveWorkspaceIdByNameFuzzy(
  name: string,
  options: ResolveWorkspaceOptions = {}
): Promise<ResolvedWorkspace> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('--workspace value is empty.');
  }

  const workspaces = await fetchWorkspaceList(options);

  try {
    return matchStrict(workspaces, trimmed);
  } catch (err) {
    if (
      !(err instanceof Error) ||
      !err.message.endsWith(WORKSPACE_NOT_FOUND_SUFFIX)
    ) {
      throw err;
    }

    const normalizedTarget = normalizeForFuzzyMatch(trimmed);
    if (!normalizedTarget) {
      throw err;
    }
    const normalized = workspaces.filter(
      (ws) => normalizeForFuzzyMatch(ws.displayName) === normalizedTarget
    );
    if (normalized.length === 1) {
      return { id: normalized[0].id, displayName: normalized[0].displayName };
    }
    if (normalized.length > 1) {
      throw new Error(
        `Multiple workspaces match "${trimmed}" (normalized). Pass --workspace-id <guid> to disambiguate. Candidates:\n${normalized
          .map((ws) => `  - "${ws.displayName}" (${ws.id})`)
          .join('\n')}`
      );
    }

    throw err;
  }
}

/**
 * Pass 1 (case-sensitive exact) + Pass 2 (case-insensitive) matching
 * against an already-fetched workspace list. Shared by
 * {@link resolveWorkspaceIdByName} and {@link resolveWorkspaceIdByNameFuzzy}
 * @throws `Error` When there isn't exactly one match.
 */
function matchStrict(
  workspaces: readonly ResolvedWorkspace[],
  trimmed: string
): ResolvedWorkspace {
  // Pass 1: case-sensitive exact match.
  const exact = workspaces.filter((ws) => ws.displayName === trimmed);
  if (exact.length === 1) {
    return { id: exact[0].id, displayName: exact[0].displayName };
  }
  if (exact.length > 1) {
    // Multiple exact matches — extremely rare but possible since Fabric
    // doesn't enforce uniqueness across capacities.
    throw new Error(
      `Multiple workspaces match "${trimmed}" exactly. Pass --workspace-id <guid> to disambiguate. Matching IDs:\n${exact
        .map((ws) => `  - ${ws.id}`)
        .join('\n')}`
    );
  }

  // Pass 2: case-insensitive match.
  const lowered = trimmed.toLowerCase();
  const ci = workspaces.filter(
    (ws) => ws.displayName.toLowerCase() === lowered
  );
  if (ci.length === 1) {
    return { id: ci[0].id, displayName: ci[0].displayName };
  }
  if (ci.length > 1) {
    throw new Error(
      `Multiple workspaces match "${trimmed}" (case-insensitive). Pass --workspace-id <guid> to disambiguate. Candidates:\n${ci
        .map((ws) => `  - "${ws.displayName}" (${ws.id})`)
        .join('\n')}`
    );
  }

  throw new Error(
    `Workspace "${trimmed}" not found. Please retry with a valid workspace name.`
  );
}

/**
 * List the workspaces the authenticated principal can access, narrowed to the
 * `{ id, displayName }` fields the CLI's interactive picker consumes.
 *
 * Shares the token-acquisition order of {@link resolveWorkspaceIdByName} so the
 * `--workspace <name>` flag path and the interactive picker path authenticate
 * identically. Callers that already hold a Fabric token (e.g. `rayfin up` after
 * `ensureAuthenticated()`) pass it via `options.token` to skip re-acquisition.
 *
 * @throws `Error` When authentication fails. The message is user-actionable and
 *   safe to surface directly via `modeError`.
 */
export async function listAccessibleWorkspaces(
  options: ResolveWorkspaceOptions = {}
): Promise<ResolvedWorkspace[]> {
  const token =
    options.token ??
    (await acquireToken(options.tenantId, options.interactive ?? false));

  const workspaceManager = new WorkspaceManager(token);
  const workspaces = await workspaceManager.listWorkspaces();
  return workspaces.map((ws) => ({ id: ws.id, displayName: ws.displayName }));
}
