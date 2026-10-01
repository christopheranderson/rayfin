/**
 * Strategy interface — encapsulates per-file-type read/write/hash semantics.
 *
 * Two implementations:
 * - `SkillStrategy` for `.agents/skills/<name>/SKILL.md` files (whole-file ownership
 *   marked by `rayfin-managed: true` frontmatter).
 * - `McpKeyStrategy` for `mcpServers.<name>` entries inside `.mcp.json` (key-level
 *   ownership; user-added sibling keys are preserved on update).
 *
 * Adoption (re-claiming on-disk content when the lockfile is missing) is delegated to
 * the manager: it queries `hasManagedSigil` (skill) or compares canonical content
 * directly (mcp).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Descriptor, ItemRef } from '../types.js';

/** sha256 hex digest of a UTF-8 string. Shared by both strategies and by descriptors. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Reads `filePath` as UTF-8, returning `null` when the file does not exist.
 * Avoids the existsSync+readFileSync double-stat (and TOCTOU window) by
 * relying on the syscall's own ENOENT.
 */
export function readIfPresent(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

export interface Strategy {
  /**
   * Reads the canonical, hashable representation of the on-disk item.
   *
   * For skills: the SKILL.md file content (line endings normalized to `\n`).
   * For mcp:    the canonical JSON of the value at `mcpServers.<name>`.
   *
   * Returns `null` when the item is absent on disk.
   */
  read(projectRoot: string, item: ItemRef): string | null;

  /** sha256 hex digest of canonical content (the value returned by `read`). */
  hash(canonicalContent: string): string;

  /**
   * Writes the bundled content into the project, preserving any user-owned
   * siblings (other keys in `.mcp.json`, other skill folders, other content in
   * the file).
   *
   * `bundledContent` is the raw asset content. Implementations are responsible for
   * any per-strategy transformation (e.g., stamping `rayfin-managed: true` into
   * skill frontmatter).
   *
   * `force` (default false) instructs the strategy to overwrite even if existing
   * on-disk state is malformed in a way that would normally make `read()` throw
   * `unreadable`. When false, the strategy may refuse to operate on hostile
   * shapes (preserves user data); when true, it must rebuild from scratch.
   *
   * Returns the canonical content actually written (so the caller can hash and
   * record it without re-reading the file).
   */
  write(
    projectRoot: string,
    descriptor: Descriptor,
    bundledContent: string,
    force?: boolean
  ): string;

  /** Removes the managed item from disk. No-op if already absent. */
  delete(projectRoot: string, item: ItemRef): void;

  /**
   * Converts raw bundled-asset content to the canonical form returned by `read`.
   * Used by adoption to compare on-disk content against bundled content without
   * actually writing the file.
   */
  canonicalizeBundled(bundledContent: string): string;

  /**
   * For skill items: returns true when the on-disk content carries the
   * `rayfin-managed: true` frontmatter sigil.
   *
   * For mcp items: always returns false (the key existing is not by itself a
   * signal that the value was Rayfin-written; adoption uses exact content match).
   */
  hasManagedSigil(canonicalContent: string): boolean;
}
