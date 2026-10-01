import { describe, it, expect } from 'vitest';

import { parseGitUrl, normalizeGitUrl, buildCacheKey } from '../git/resolver';

describe('parseGitUrl', () => {
  it('parses a simple HTTPS URL', () => {
    const result = parseGitUrl('https://github.com/org/repo.git');
    expect(result.url).toBe('https://github.com/org/repo.git');
    expect(result.ref).toBeUndefined();
  });

  it('parses URL with #ref', () => {
    const result = parseGitUrl('https://github.com/org/repo.git#main');
    expect(result.url).toBe('https://github.com/org/repo.git');
    expect(result.ref).toBe('main');
  });

  it('parses URL with tag ref', () => {
    const result = parseGitUrl('https://github.com/org/repo.git#v1.0.0');
    expect(result.url).toBe('https://github.com/org/repo.git');
    expect(result.ref).toBe('v1.0.0');
  });

  it('parses SSH URL', () => {
    const result = parseGitUrl('git@github.com:org/repo.git');
    expect(result.url).toBe('git@github.com:org/repo.git');
    expect(result.ref).toBeUndefined();
  });

  it('throws on empty input', () => {
    expect(() => parseGitUrl('')).toThrow('cannot be empty');
  });

  it('throws on empty ref after #', () => {
    expect(() => parseGitUrl('https://github.com/org/repo.git#')).toThrow(
      'Empty ref'
    );
  });

  it('accepts full 40-char commit SHAs', () => {
    const sha = 'abc1234567890abc1234567890abc1234567890a';
    const result = parseGitUrl(`https://github.com/org/repo.git#${sha}`);
    expect(result.ref).toBe(sha);
  });

  it('rejects commit SHA abbreviations (7+ hex chars)', () => {
    expect(() =>
      parseGitUrl('https://github.com/org/repo.git#abc1234')
    ).toThrow('Abbreviated commit SHAs are not supported');

    expect(() =>
      parseGitUrl('https://github.com/org/repo.git#deadbeef')
    ).toThrow('Abbreviated commit SHAs are not supported');
  });

  it('allows short hex strings under 7 chars as branch names', () => {
    const result = parseGitUrl('https://github.com/org/repo.git#abc123');
    expect(result.ref).toBe('abc123');
  });

  it('rejects dash-prefixed refs', () => {
    expect(() => parseGitUrl('https://github.com/org/repo.git#--evil')).toThrow(
      'cannot start with a dash'
    );
  });

  it('allows branch names with slashes', () => {
    const result = parseGitUrl('https://github.com/org/repo.git#feature/auth');
    expect(result.ref).toBe('feature/auth');
  });
});

describe('normalizeGitUrl', () => {
  it('strips .git suffix', () => {
    expect(normalizeGitUrl('https://github.com/org/repo.git')).toBe(
      'https://github.com/org/repo'
    );
  });

  it('leaves URLs without .git unchanged', () => {
    expect(normalizeGitUrl('https://github.com/org/repo')).toBe(
      'https://github.com/org/repo'
    );
  });
});

describe('buildCacheKey', () => {
  it('builds key without ref', () => {
    const key = buildCacheKey({ url: 'https://github.com/org/repo.git' });
    expect(key).toBe('https://github.com/org/repo');
  });

  it('builds key with ref', () => {
    const key = buildCacheKey({
      url: 'https://github.com/org/repo.git',
      ref: 'main',
    });
    expect(key).toBe('https://github.com/org/repo#main');
  });
});

describe('parseGitUrl — fuzz-style property tests', () => {
  // Helper to generate random refs (avoiding hex-only patterns that look like SHAs)
  function randomRef(seed: number): string {
    const chars = 'ghijklmnopqrstuvwxyz-._/';
    let s = '';
    let n = seed;
    for (let i = 0; i < 8; i++) {
      s += chars[n % chars.length];
      n = (n * 1103515245 + 12345) & 0x7fffffff;
    }
    return s;
  }

  it('round-trips arbitrary refs through parseGitUrl', () => {
    const baseUrls = [
      'https://github.com/org/repo.git',
      'https://gitlab.com/team/project.git',
      'git@github.com:org/repo.git',
      'ssh://git@example.com/path/repo.git',
      'file:///tmp/local-repo',
    ];
    // Refs that should round-trip cleanly (no SHA patterns, no dash prefix)
    const refs = [
      'main',
      'develop',
      'v1.0.0',
      'feature/long-name-here',
      'release-2025q4',
      'rc-1',
    ];

    for (const baseUrl of baseUrls) {
      for (const ref of refs) {
        const input = `${baseUrl}#${ref}`;
        const parsed = parseGitUrl(input);
        expect(parsed.url).toBe(baseUrl);
        expect(parsed.ref).toBe(ref);
      }
    }
  });

  it('rejects dash-prefixed refs (flag injection)', () => {
    const dashRefs = [
      '--upload-pack=evil',
      '-x',
      '--config=core.sshCommand=evil',
    ];
    for (const ref of dashRefs) {
      expect(() =>
        parseGitUrl(`https://github.com/org/repo.git#${ref}`)
      ).toThrow(/dash/i);
    }
  });

  it('rejects abbreviated refs that look like commit SHAs (7-39 hex chars)', () => {
    const shaPatterns = [
      'abc1234', // 7-char short SHA
      'abc1234567890abc', // 16-char hex
      '0123456789abcdef', // all valid hex
    ];
    for (const ref of shaPatterns) {
      expect(() =>
        parseGitUrl(`https://github.com/org/repo.git#${ref}`)
      ).toThrow(/abbreviated commit/i);
    }
  });

  it('accepts hex-like refs that are not pure hex (mixed alpha)', () => {
    // 'release-abc' has hex chars but also non-hex chars, should be accepted
    const result = parseGitUrl('https://github.com/org/repo.git#release-abc');
    expect(result.ref).toBe('release-abc');
  });

  it('rejects empty ref (trailing #)', () => {
    expect(() => parseGitUrl('https://github.com/org/repo.git#')).toThrow(
      /empty ref/i
    );
  });

  it('handles empty string and whitespace consistently', () => {
    const empties = ['', ' ', '\t', '\n', '   '];
    for (const input of empties) {
      expect(() => parseGitUrl(input)).toThrow(/empty/i);
    }
  });

  it('preserves URL structure for many random ref values', () => {
    // 50 pseudo-random refs — verify .url is always the base, .ref is always the suffix
    const baseUrl = 'https://github.com/org/repo.git';
    let validCount = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const ref = randomRef(seed);
      // Skip refs that the validator legitimately rejects
      if (ref.startsWith('-')) continue;
      const input = `${baseUrl}#${ref}`;
      const parsed = parseGitUrl(input);
      expect(parsed.url).toBe(baseUrl);
      expect(parsed.ref).toBe(ref);
      validCount++;
    }
    // Sanity check: most of our random refs should have been valid
    expect(validCount).toBeGreaterThan(40);
  });

  it('preserves all characters in URLs (no normalization until normalizeGitUrl)', () => {
    // URLs with various characters should pass through .url unchanged
    const urls = [
      'https://user@github.com/org/repo.git',
      'https://github.com/org/repo-with-dashes.git',
      'https://github.com:443/org/repo.git',
      'ssh://git@host.example.com:22/path/to/repo.git',
    ];
    for (const url of urls) {
      const result = parseGitUrl(url);
      expect(result.url).toBe(url);
      expect(result.ref).toBeUndefined();
    }
  });
});
