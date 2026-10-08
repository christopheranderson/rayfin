/**
 * `SkillStrategy` — Whole-file ownership for `.agents/skills/<name>/SKILL.md`.
 *
 * Ownership sigil: `rayfin-managed: true` in YAML frontmatter. Removing this
 * frontmatter key is the user's opt-out; the manager sees no sigil and stops
 * touching the file.
 *
 * Frontmatter is parsed via the `yaml` package (full YAML, not regex) so the
 * sigil check is robust to quoted booleans, comments, multi-line values, and
 * future frontmatter fields.
 *
 * Line-ending normalization (CRLF → LF) is applied before hashing so that
 * platform-specific line ending rewrites don't surface as user modifications.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { writeFileAtomic } from '../../../utils/atomic-write.js';
import type { Descriptor, ItemRef } from '../types.js';

import { readIfPresent, sha256Hex } from './strategy.js';
import type { Strategy } from './strategy.js';

const FRONTMATTER_DELIM = '---';
const MANAGED_KEY = 'rayfin-managed';

class SkillStrategyImpl implements Strategy {
  read(projectRoot: string, item: ItemRef): string | null {
    const raw = readIfPresent(this.skillFilePath(projectRoot, item));
    return raw === null ? null : this.normalize(raw);
  }

  hash(canonicalContent: string): string {
    return sha256Hex(canonicalContent);
  }

  write(
    projectRoot: string,
    descriptor: Descriptor,
    bundledContent: string,
    _force?: boolean
  ): string {
    // SkillStrategy owns the entire SKILL.md file and overwrites unconditionally,
    // so `force` is unused here. Accepting it keeps the Strategy.write signature
    // uniform across strategies (see McpKeyStrategy where it matters).
    const stamped = this.stampManagedFlag(this.normalize(bundledContent));
    const filePath = this.skillFilePath(projectRoot, descriptor);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileAtomic(filePath, stamped, 'utf8');
    return stamped;
  }

  delete(projectRoot: string, item: ItemRef): void {
    const skillDir = join(projectRoot, '.agents', 'skills', item.name);
    rmSync(skillDir, { recursive: true, force: true });
  }

  canonicalizeBundled(bundledContent: string): string {
    return this.stampManagedFlag(this.normalize(bundledContent));
  }

  hasManagedSigil(canonicalContent: string): boolean {
    const fm = parseFrontmatter(canonicalContent);
    if (!fm) return false;
    let parsed: unknown;
    try {
      parsed = parseYaml(fm.frontmatterText);
    } catch {
      return false;
    }
    if (parsed === null || typeof parsed !== 'object') return false;
    return (parsed as Record<string, unknown>)[MANAGED_KEY] === true;
  }

  // ── Internals ──

  private skillFilePath(projectRoot: string, item: ItemRef): string {
    return join(projectRoot, '.agents', 'skills', item.name, 'SKILL.md');
  }

  /**
   * Normalize line endings so CRLF rewrites on Windows do not surface as
   * user-modified state on subsequent updates.
   */
  private normalize(content: string): string {
    return content.replace(/\r\n/g, '\n');
  }

  /**
   * Ensure the frontmatter contains `rayfin-managed: true`. The frontmatter is
   * parsed as YAML, the sigil key is set on the resulting object, and the
   * frontmatter block is re-serialized — preserving every other field the
   * bundled asset author wrote.
   *
   * If frontmatter is absent, prepend a minimal block.
   */
  private stampManagedFlag(content: string): string {
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      const block = `${FRONTMATTER_DELIM}\n${MANAGED_KEY}: true\n${FRONTMATTER_DELIM}\n`;
      return block + content;
    }

    const { frontmatterText, body } = parsed;
    const data =
      frontmatterText.trim() === '' ? {} : (parseYaml(frontmatterText) ?? {});
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(
        `Frontmatter must be a YAML mapping; got ${Array.isArray(data) ? 'array' : typeof data}.`
      );
    }
    (data as Record<string, unknown>)[MANAGED_KEY] = true;
    const newFrontmatter = stringifyYaml(data, { lineWidth: 0 }).replace(
      /\n+$/,
      ''
    );
    return `${FRONTMATTER_DELIM}\n${newFrontmatter}\n${FRONTMATTER_DELIM}\n${body}`;
  }
}

interface ParsedFrontmatter {
  frontmatterText: string;
  body: string;
}

/**
 * Extract the frontmatter block at the top of a markdown file. Tolerates a
 * leading BOM and CRLF line endings; returns null if the file has no
 * frontmatter delimiter pair.
 */
function parseFrontmatter(content: string): ParsedFrontmatter | null {
  // Strip a single leading BOM if present.
  const text = content.startsWith('\ufeff') ? content.slice(1) : content;
  if (
    !text.startsWith(`${FRONTMATTER_DELIM}\n`) &&
    text !== FRONTMATTER_DELIM
  ) {
    // Allow `---` as the very first line followed by EOF, but generally we need a newline.
    if (!text.startsWith(`${FRONTMATTER_DELIM}\r\n`)) {
      return null;
    }
  }
  const afterOpen = text.slice(FRONTMATTER_DELIM.length).replace(/^\r?\n/, '');
  // Find the closing delimiter on its own line.
  const closeMatch = afterOpen.match(/^---\s*$/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return null;
  }
  const frontmatterText = afterOpen
    .slice(0, closeMatch.index)
    .replace(/\n+$/, '');
  const body = afterOpen
    .slice(closeMatch.index + closeMatch[0].length)
    .replace(/^\r?\n/, '');
  return { frontmatterText, body };
}

export const skillStrategy: Strategy = new SkillStrategyImpl();
