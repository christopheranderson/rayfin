import { describe, it, expect } from 'vitest';

import {
  QUALIFIED_REF_PREFIXES,
  isAbbreviatedCommitShaRef,
  isBranchSentinel,
  isDashPrefixed,
  isFullCommitShaRef,
  isQualifiedBranchRef,
  isValidShortRefName,
  stripQualifiedRefPrefix,
} from '../git/ref-shapes';

describe('ref-shapes — shape predicates', () => {
  describe('isFullCommitShaRef', () => {
    it('accepts exactly 40 hex chars (mixed case)', () => {
      expect(
        isFullCommitShaRef('568c87fb262bde360a85e62e8f88700bab450478')
      ).toBe(true);
      expect(
        isFullCommitShaRef('ABCDEF1234567890ABCDEF1234567890ABCDEF12')
      ).toBe(true);
    });

    it('rejects anything other than exactly 40 hex chars', () => {
      expect(isFullCommitShaRef('568c87f')).toBe(false); // 7
      expect(
        isFullCommitShaRef('568c87fb262bde360a85e62e8f88700bab45047')
      ).toBe(false); // 39
      expect(
        isFullCommitShaRef('568c87fb262bde360a85e62e8f88700bab4504788')
      ).toBe(false); // 41
      expect(
        isFullCommitShaRef('568c87fb262bde360a85e62e8f88700bab45047g')
      ).toBe(false); // non-hex
      expect(isFullCommitShaRef('')).toBe(false);
    });
  });

  describe('isAbbreviatedCommitShaRef', () => {
    it('accepts 7-39 hex chars', () => {
      expect(isAbbreviatedCommitShaRef('568c87f')).toBe(true); // 7
      expect(isAbbreviatedCommitShaRef('abc1234')).toBe(true);
      expect(isAbbreviatedCommitShaRef('deadbeef')).toBe(true); // 8
      expect(
        isAbbreviatedCommitShaRef('568c87fb262bde360a85e62e8f88700bab45047')
      ).toBe(true); // 39
    });

    it('rejects <7, ==40, >40, and non-hex chars', () => {
      expect(isAbbreviatedCommitShaRef('abc123')).toBe(false); // 6
      expect(
        isAbbreviatedCommitShaRef('568c87fb262bde360a85e62e8f88700bab450478')
      ).toBe(false); // 40
      expect(
        isAbbreviatedCommitShaRef('568c87fb262bde360a85e62e8f88700bab4504788')
      ).toBe(false); // 41
      expect(isAbbreviatedCommitShaRef('release-abc')).toBe(false); // has hyphen
      expect(isAbbreviatedCommitShaRef('v1234567')).toBe(false); // has 'v'
      expect(isAbbreviatedCommitShaRef('')).toBe(false);
    });
  });

  describe('isDashPrefixed', () => {
    it('accepts refs starting with -', () => {
      expect(isDashPrefixed('-rf')).toBe(true);
      expect(isDashPrefixed('--upload-pack=evil')).toBe(true);
      expect(isDashPrefixed('-')).toBe(true);
    });

    it('rejects refs not starting with -', () => {
      expect(isDashPrefixed('v1')).toBe(false);
      expect(isDashPrefixed('release-2024-01')).toBe(false); // hyphen mid-string
      expect(isDashPrefixed('')).toBe(false);
    });
  });

  describe('isBranchSentinel', () => {
    it('accepts known sentinels (case-insensitive)', () => {
      for (const ref of [
        'HEAD',
        'head',
        'Head',
        'FETCH_HEAD',
        'fetch_head',
        'main',
        'Main',
        'MAIN',
        'master',
        'develop',
        'trunk',
      ]) {
        expect(isBranchSentinel(ref), `expected ${ref} sentinel`).toBe(true);
      }
    });

    it('rejects non-sentinel branch-like names', () => {
      expect(isBranchSentinel('feature/auth')).toBe(false);
      expect(isBranchSentinel('release/v1')).toBe(false);
      expect(isBranchSentinel('main-branch')).toBe(false);
      expect(isBranchSentinel('mainnet')).toBe(false);
      expect(isBranchSentinel('v1')).toBe(false);
      expect(isBranchSentinel('')).toBe(false);
    });
  });

  describe('isQualifiedBranchRef', () => {
    it('accepts refs/heads/* at any depth (case-insensitive prefix)', () => {
      expect(isQualifiedBranchRef('refs/heads/main')).toBe(true);
      expect(isQualifiedBranchRef('refs/heads/feature/auth')).toBe(true);
      expect(isQualifiedBranchRef('refs/heads/release/v1.0')).toBe(true);
      expect(isQualifiedBranchRef('Refs/Heads/main')).toBe(true);
    });

    it('rejects refs/tags/* and unqualified refs', () => {
      expect(isQualifiedBranchRef('refs/tags/v1')).toBe(false);
      expect(isQualifiedBranchRef('main')).toBe(false);
      expect(isQualifiedBranchRef('')).toBe(false);
    });
  });

  describe('QUALIFIED_REF_PREFIXES', () => {
    it('lists both qualified-ref forms', () => {
      expect(QUALIFIED_REF_PREFIXES).toEqual(['refs/tags/', 'refs/heads/']);
    });
  });
});

describe('ref-shapes — isValidShortRefName (acceptance predicate)', () => {
  it('accepts non-empty, non-dash, non-abbrev-SHA names', () => {
    expect(isValidShortRefName('v1')).toBe(true);
    expect(isValidShortRefName('v1.0.0')).toBe(true);
    expect(isValidShortRefName('release-2024-01')).toBe(true);
    expect(isValidShortRefName('feature/auth')).toBe(true);
    expect(isValidShortRefName('lts')).toBe(true);
    expect(isValidShortRefName('a')).toBe(true);
  });

  it('rejects empty', () => {
    expect(isValidShortRefName('')).toBe(false);
  });

  it('rejects dash-prefixed', () => {
    expect(isValidShortRefName('-rf')).toBe(false);
    expect(isValidShortRefName('--upload-pack=evil')).toBe(false);
  });

  it('rejects abbreviated SHAs', () => {
    expect(isValidShortRefName('568c87f')).toBe(false);
    expect(isValidShortRefName('deadbeef')).toBe(false);
  });

  it('accepts full SHAs (they are valid short ref names too)', () => {
    // Full SHAs pass this predicate because they are not 7-39-hex-shaped.
    // Callers that want to special-case full SHAs (the fetcher does) use
    // isFullCommitShaRef earlier in the chain.
    expect(
      isValidShortRefName('568c87fb262bde360a85e62e8f88700bab450478')
    ).toBe(true);
  });
});

describe('ref-shapes — stripQualifiedRefPrefix', () => {
  it('strips refs/tags/ from valid tails', () => {
    expect(stripQualifiedRefPrefix('refs/tags/v1')).toBe('v1');
    expect(stripQualifiedRefPrefix('refs/tags/v1.2.3-rc.1')).toBe(
      'v1.2.3-rc.1'
    );
    expect(stripQualifiedRefPrefix('refs/tags/release-2024-01')).toBe(
      'release-2024-01'
    );
  });

  it('strips refs/heads/ from valid tails', () => {
    expect(stripQualifiedRefPrefix('refs/heads/main')).toBe('main');
    expect(stripQualifiedRefPrefix('refs/heads/feature/auth')).toBe(
      'feature/auth'
    );
  });

  it('returns input unchanged when no qualified prefix matches', () => {
    expect(stripQualifiedRefPrefix('v1')).toBe('v1');
    expect(stripQualifiedRefPrefix('main')).toBe('main');
    expect(
      stripQualifiedRefPrefix('568c87fb262bde360a85e62e8f88700bab450478')
    ).toBe('568c87fb262bde360a85e62e8f88700bab450478');
  });

  it.each([['refs/tags/'], ['refs/heads/']])(
    'throws on empty-tail input %s',
    (ref) => {
      expect(() => stripQualifiedRefPrefix(ref)).toThrow(
        /qualified refs must have a non-empty tail/
      );
    }
  );

  it.each([
    ['refs/tags/-rf'],
    ['refs/tags/--upload-pack=evil'],
    ['refs/heads/-rf'],
  ])('throws on dash-prefixed tail %s', (ref) => {
    expect(() => stripQualifiedRefPrefix(ref)).toThrow(
      /fails the short-ref-name shape check/
    );
  });

  it.each([
    ['refs/tags/568c87f'],
    ['refs/tags/deadbeef'],
    ['refs/tags/abc1234567890abc1234567890abc1234567890'], // 40 hex but inside refs/tags/ - this IS a full SHA shape but git tags can be SHA-shaped strings; we still strip and pass through
    ['refs/heads/568c87f'],
  ])(
    'throws on abbreviated-SHA-shaped tail (except full 40-char SHAs which are valid short names): %s',
    (ref) => {
      const tail = ref.replace(/^refs\/(tags|heads)\//, '');
      if (tail.length === 40 && /^[0-9a-f]{40}$/i.test(tail)) {
        // Full 40-char SHAs ARE valid short ref names per isValidShortRefName;
        // they pass through unchanged.
        expect(stripQualifiedRefPrefix(ref)).toBe(tail);
      } else {
        expect(() => stripQualifiedRefPrefix(ref)).toThrow(
          /fails the short-ref-name shape check/
        );
      }
    }
  );
});

describe('ref-shapes — cross-source consistency invariant', () => {
  // The whole point of consolidating ref-shapes is that the same string
  // gets the same answer from every boundary that needs to validate it.
  // These cases enumerate the "malformed" set and assert both:
  //   1. isValidShortRefName rejects the bare form.
  //   2. stripQualifiedRefPrefix throws on the qualified form.
  // If either side ever drifts, this test fails - which is exactly the
  // "Security validations must propagate to all sibling source types"
  // principle codified.
  const malformedTails = [
    '',
    '-rf',
    '--upload-pack=evil',
    '568c87f',
    'deadbeef',
  ];

  it.each(malformedTails)(
    'unqualified form %s is rejected by isValidShortRefName',
    (tail) => {
      expect(isValidShortRefName(tail)).toBe(false);
    }
  );

  it.each(malformedTails)(
    'qualified-tag form refs/tags/%s throws in stripQualifiedRefPrefix',
    (tail) => {
      expect(() => stripQualifiedRefPrefix(`refs/tags/${tail}`)).toThrow();
    }
  );

  it.each(malformedTails)(
    'qualified-branch form refs/heads/%s throws in stripQualifiedRefPrefix',
    (tail) => {
      expect(() => stripQualifiedRefPrefix(`refs/heads/${tail}`)).toThrow();
    }
  );
});
