/**
 * Resolve a Fabric item display name to its ID, mirroring
 * `resolve-workspace-name.ts`'s matching rules for `--item <name>`.
 */

import type { FabricItem } from '../services/fabric/rayfin-item.js';
import { RayfinItemManager } from '../services/fabric/rayfin-item.js';

import { normalizeForFuzzyMatch } from './normalize-name.js';

export interface ResolvedItem {
  id: string;
  displayName: string;
  type: string;
}

/**
 * Resolve a Fabric item display name to its ID within a given workspace.
 *
 * @param options - Auth token and optional Fabric item type filter.
 * @throws `Error` When the name doesn't match exactly one item.
 */
export async function resolveItemIdByName(
  workspaceId: string,
  name: string,
  options: {
    token: string;
    type?: string;
  }
): Promise<ResolvedItem> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('--item value is empty.');
  }

  const itemManager = new RayfinItemManager(options.token);
  const items = await itemManager.listItems(workspaceId, options.type);

  const toResolved = (item: FabricItem): ResolvedItem => ({
    id: item.id,
    displayName: item.displayName,
    type: item.type,
  });

  // Pass 1: case-sensitive exact match.
  const exact = items.filter((item) => item.displayName === trimmed);
  if (exact.length === 1) {
    return toResolved(exact[0]);
  }
  if (exact.length > 1) {
    return disambiguate(trimmed, exact.map(toResolved), 'exactly');
  }

  // Pass 2: case-insensitive match.
  const lowered = trimmed.toLowerCase();
  const ci = items.filter((item) => item.displayName.toLowerCase() === lowered);
  if (ci.length === 1) {
    return toResolved(ci[0]);
  }
  if (ci.length > 1) {
    return disambiguate(trimmed, ci.map(toResolved), '(case-insensitive)');
  }

  // Pass 3: normalized match, ignoring case/punctuation via Unicode-aware
  // normalization, so cosmetic naming differences don't block a match.
  const normalizedTarget = normalizeForFuzzyMatch(trimmed);
  if (!normalizedTarget) {
    throwNotFound(trimmed, options.type);
  }
  const normalized = items.filter(
    (item) => normalizeForFuzzyMatch(item.displayName) === normalizedTarget
  );
  if (normalized.length === 1) {
    return toResolved(normalized[0]);
  }
  if (normalized.length > 1) {
    return disambiguate(trimmed, normalized.map(toResolved));
  }

  throwNotFound(trimmed, options.type);
}

function throwNotFound(trimmed: string, type?: string): never {
  throw new Error(
    type
      ? `Item "${trimmed}" not found in this workspace (filtered to type ${type}).`
      : `Item "${trimmed}" not found in this workspace.`
  );
}

/**
 * Throws a disambiguation error listing every candidate so the caller
 * can retry with `--item-id <guid>`.
 */
function disambiguate(
  trimmed: string,
  candidates: ResolvedItem[],
  qualifier?: string
): never {
  const suffix = qualifier ? ` ${qualifier}` : '';
  throw new Error(
    `Multiple items match "${trimmed}"${suffix}. Pass --item-id <guid> to disambiguate. Candidates:\n${candidates
      .map((item) => `  - "${item.displayName}" (${item.id}, ${item.type})`)
      .join('\n')}`
  );
}
