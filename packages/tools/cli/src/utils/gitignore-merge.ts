/**
 * Merge a managed `.gitignore` (e.g. the bundled
 * `assets/.gitignore.template`) into a pre-existing `.gitignore` without
 * clobbering the template author's or end-user's customizations.
 *
 * Background: external templates (and any project that pre-dates a Rayfin
 * scaffold) frequently ship their own `.gitignore`. The previous behavior
 * — copy the bundled asset over the existing file under `--from-template`
 * — silently destroyed those customizations. The merge here is the
 * minimum viable fix: keep what is already there, append only what is
 * missing, label the appended block so a human reading the diff knows
 * where it came from.
 *
 * Algorithm:
 *  1. Collect the set of meaningful pattern lines already in the existing
 *     file (trimmed; comments and blank lines ignored — they are layout,
 *     not behavior).
 *  2. Walk the source file, collect each meaningful pattern line in order.
 *  3. Compute `missing = sourcePatterns - existingPatterns`, preserving
 *     source order so the appended block matches the asset's reading
 *     order.
 *  4. If nothing is missing, return the existing content unchanged
 *     (idempotent: re-running a sync never mutates a fully covered file).
 *  5. Otherwise append a labeled section at the end so the addition is
 *     diff-visible and re-running the merge is a no-op.
 *
 * Comments and section headers from the source are intentionally NOT
 * carried over: they are formatting hints for the asset's standalone
 * rendering, not pattern semantics. Carrying them would either duplicate
 * existing commentary (when the user already wrote `# Logs`) or fragment
 * the appended block with unrelated headers when only one pattern is
 * actually missing.
 *
 * Known limitations (forward-looking, not active issues with the current
 * bundled `assets/.gitignore.template`):
 *
 *  - **Multi-block accretion across CLI releases.** When the bundled
 *    asset gains a new canonical pattern in a later release, projects
 *    that already have the v1 `# Added by Rayfin CLI` block will receive
 *    a *second* `# Added by Rayfin CLI` block on next sync. Functionally
 *    correct (still idempotent per-release; the sets remain disjoint)
 *    but the "single managed section" promise erodes over releases. If
 *    this ever bites, swap to a delimited begin/end sentinel pair so the
 *    contents of the existing block can be replaced in place.
 *
 *  - **Append-only is incompatible with source-side negation patterns.**
 *    The merge always appends at the end. `.gitignore` evaluates rules in
 *    order, so a source-side negation (`!keep-me`) appended after a
 *    broader ignore in the existing file will have no effect. The current
 *    bundled asset has no negations, so this is purely forward-looking;
 *    a guard test (in `gitignore-merge.test.ts`) asserts the asset stays
 *    negation-free. If a future canonical pattern needs negation
 *    semantics, adopt the delimited-section approach above so negations
 *    can be inserted at a deterministic position.
 */
const RAYFIN_SECTION_HEADER = '# Added by Rayfin CLI';

export function mergeGitignore(existing: string, source: string): string {
  const existingPatterns = collectPatterns(existing);
  const sourcePatterns = listPatterns(source);

  const missing = sourcePatterns.filter((p) => !existingPatterns.has(p));
  if (missing.length === 0) {
    return existing;
  }

  // Normalize line endings to match the existing file's style so we don't
  // leave a mixed-EOL file after merging (Windows users routinely have
  // CRLF .gitignore files; appending LF-only patterns would corrupt them
  // and defeat idempotency on the next sync).
  const eol = detectEol(existing);
  // Strip ONLY trailing newlines, not arbitrary trailing whitespace. In
  // gitignore syntax an escaped trailing space is significant (`foo\ `
  // matches a file ending in a literal space), so a `/\s+$/` trim would
  // silently corrupt the last template-author pattern.
  const trimmedExisting = existing.replace(/(\r?\n)+$/, '');
  const appendedBlock = `${RAYFIN_SECTION_HEADER}${eol}${missing.join(eol)}`;
  return trimmedExisting === ''
    ? `${appendedBlock}${eol}`
    : `${trimmedExisting}${eol}${eol}${appendedBlock}${eol}`;
}

function detectEol(content: string): string {
  // Pick the dominant line ending in the existing file. A previous version
  // used pure existence (`/\r\n/.test`), which meant a single stray CRLF
  // anywhere in an otherwise-LF file would flip the appended block to CRLF
  // - leaving the file in a worse mixed-EOL state than it started in
  // (realistic when a Linux dev once vim-edited a file that originated on
  // Windows). Counting and picking the dominant style avoids that. Default
  // to LF for brand-new files so they match the rest of the codebase's
  // POSIX convention.
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lfOnly = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lfOnly ? '\r\n' : '\n';
}

function collectPatterns(content: string): Set<string> {
  return new Set(listPatterns(content));
}

function listPatterns(content: string): string[] {
  const patterns: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    patterns.push(line);
  }
  return patterns;
}
