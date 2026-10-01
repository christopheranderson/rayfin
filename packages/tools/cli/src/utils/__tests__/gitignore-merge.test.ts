import { describe, it, expect } from 'vitest';

import { mergeGitignore } from '../gitignore-merge.js';

describe('mergeGitignore', () => {
  const RAYFIN_REQUIRED = [
    'rayfin/.env*',
    'rayfin/.deployments.json',
    'rayfin/.temp/',
  ].join('\n');

  it('preserves the template author lines and appends only what is missing', () => {
    const existing = [
      '# CUSTOM TEMPLATE GITIGNORE',
      'node_modules',
      'dist',
      '.env.template-secret',
      'my-template-cache/',
    ].join('\n');

    const merged = mergeGitignore(existing, RAYFIN_REQUIRED);

    // Template author lines untouched.
    expect(merged).toContain('# CUSTOM TEMPLATE GITIGNORE');
    expect(merged).toContain('.env.template-secret');
    expect(merged).toContain('my-template-cache/');

    // Rayfin-required lines are now present exactly once.
    for (const required of [
      'rayfin/.env*',
      'rayfin/.deployments.json',
      'rayfin/.temp/',
    ]) {
      const occurrences = merged
        .split('\n')
        .filter((l) => l.trim() === required);
      expect(occurrences).toHaveLength(1);
    }
  });

  it('is idempotent — second merge does not mutate or duplicate', () => {
    const existing = ['node_modules', 'dist'].join('\n');
    const onceMerged = mergeGitignore(existing, RAYFIN_REQUIRED);
    const twiceMerged = mergeGitignore(onceMerged, RAYFIN_REQUIRED);
    expect(twiceMerged).toBe(onceMerged);
  });

  it('returns the existing content unchanged when nothing is missing', () => {
    const existing = [
      'node_modules',
      'rayfin/.env*',
      'rayfin/.deployments.json',
      'rayfin/.temp/',
      '# trailing comment',
    ].join('\n');
    expect(mergeGitignore(existing, RAYFIN_REQUIRED)).toBe(existing);
  });

  it('treats comment-only / blank source lines as layout, not patterns', () => {
    const existing =
      'node_modules\nrayfin/.env*\nrayfin/.deployments.json\nrayfin/.temp/\n';
    const sourceWithLayout = [
      '# Rayfin — auto-generated or secret-bearing files',
      '',
      'rayfin/.env*',
      'rayfin/.deployments.json',
      'rayfin/.temp/',
    ].join('\n');
    expect(mergeGitignore(existing, sourceWithLayout)).toBe(existing);
  });

  it('labels the appended block so the addition is diff-visible', () => {
    const existing = '# only the user wrote this\nnode_modules\n';
    const merged = mergeGitignore(existing, 'rayfin/.env*');
    expect(merged).toContain('# Added by Rayfin CLI');
    expect(merged.indexOf('# Added by Rayfin CLI')).toBeGreaterThan(
      merged.indexOf('node_modules')
    );
  });

  it('handles existing files without a trailing newline', () => {
    const existing = 'node_modules';
    const merged = mergeGitignore(existing, 'rayfin/.env*');
    expect(merged).toMatch(
      /^node_modules\n\n# Added by Rayfin CLI\nrayfin\/\.env\*\n$/
    );
  });

  it('preserves a gitignore-significant escaped trailing space on the last pattern', () => {
    // In gitignore syntax `foo\ ` (backslash + space) matches a file
    // literally named "foo " with a trailing space. A naive `/\s+$/`
    // trim would strip the escaped space and rewrite the pattern as
    // `foo\`, silently breaking the template author's intent. Keep the
    // pattern's trailing significant whitespace intact and only strip
    // trailing newlines.
    const existing = 'foo\\ \n\n';
    const merged = mergeGitignore(existing, 'rayfin/.env*');
    expect(merged).toBe('foo\\ \n\n# Added by Rayfin CLI\nrayfin/.env*\n');
  });

  it('handles a totally empty existing file', () => {
    const merged = mergeGitignore('', 'rayfin/.env*');
    expect(merged).toBe('# Added by Rayfin CLI\nrayfin/.env*\n');
  });

  it('preserves source order when appending multiple missing patterns', () => {
    const existing = 'node_modules\n';
    const source = [
      '# Rayfin',
      'rayfin/.env*',
      'rayfin/.deployments.json',
      'rayfin/.temp/',
    ].join('\n');
    const merged = mergeGitignore(existing, source);
    const envIdx = merged.indexOf('rayfin/.env*');
    const deplIdx = merged.indexOf('rayfin/.deployments.json');
    const tempIdx = merged.indexOf('rayfin/.temp/');
    expect(envIdx).toBeLessThan(deplIdx);
    expect(deplIdx).toBeLessThan(tempIdx);
  });

  it('does not strip blank lines or comments inside the existing file', () => {
    const existing = ['# Logs', 'logs', '', '# Editor', '.idea', ''].join('\n');
    const merged = mergeGitignore(existing, 'rayfin/.env*');
    expect(merged).toContain('# Logs');
    expect(merged).toContain('# Editor');
    // Verify the blank line between sections survived
    expect(merged).toMatch(/logs\n\n# Editor/);
  });

  it('preserves CRLF line endings on Windows-authored files', () => {
    // Windows git users frequently have core.autocrlf=true, which means
    // the on-disk .gitignore is CRLF. Appending LF-only lines would leave
    // a mixed-EOL file that the next merge would still detect as needing
    // a write (idempotency would silently break) and that diff tools
    // would render as a whole-file change.
    const existing = ['node_modules', 'dist'].join('\r\n') + '\r\n';
    const merged = mergeGitignore(existing, 'rayfin/.env*');
    expect(merged).not.toMatch(/[^\r]\n/); // no bare LF anywhere
    expect(merged).toMatch(/\r\n# Added by Rayfin CLI\r\nrayfin\/\.env\*\r\n$/);
  });

  it('is idempotent across CRLF + LF passes', () => {
    const existing = 'node_modules\r\n';
    const onceMerged = mergeGitignore(existing, 'rayfin/.env*');
    const twiceMerged = mergeGitignore(onceMerged, 'rayfin/.env*');
    expect(twiceMerged).toBe(onceMerged);
  });

  it('appends with LF when LF is the dominant EOL despite a stray CRLF', () => {
    // Realistic scenario: a Linux dev once vim-edited a .gitignore that
    // originated on Windows and left one stray CRLF surviving among
    // hundreds of LFs. A pure-existence detectEol would flip the entire
    // appended block to CRLF, leaving the file in a *worse* mixed-EOL
    // state than it started in. Counting and picking the dominant style
    // keeps the appended block in the file's actual convention.
    const existing = 'a\r\nb\nc\nd\n';
    const merged = mergeGitignore(existing, 'rayfin/.env*');
    expect(merged.endsWith('\n# Added by Rayfin CLI\nrayfin/.env*\n')).toBe(
      true
    );
    // The appended block must not contain CRLF because LF was dominant.
    expect(merged).not.toMatch(/Added by Rayfin CLI\r\n/);
  });
});

describe('bundled assets/.gitignore.template invariants', () => {
  it('does not contain negation patterns (append-only merge would no-op them)', async () => {
    // Forward-looking guard: mergeGitignore always appends at the end,
    // and .gitignore evaluates rules in order, so a source-side negation
    // pattern (`!keep-me`) appended after a broader ignore in an
    // existing file has no effect. The bundled asset is negation-free
    // today; if a future asset author adds one, this test fails and
    // forces the conversation: either land a delimited managed-section
    // refactor first, or pick a non-negation pattern.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const assetPath = resolve(
      here,
      '..',
      '..',
      '..',
      'assets',
      '.gitignore.template'
    );
    const content = await readFile(assetPath, 'utf8');
    const negations = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('!'));
    expect(negations).toEqual([]);
  });
});
