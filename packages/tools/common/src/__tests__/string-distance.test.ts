import { describe, it, expect } from 'vitest';

import { levenshtein, suggestClosest } from '../string-distance.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns length of other string when one is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
  });

  it('computes single insertion', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1);
  });

  it('computes single deletion', () => {
    expect(levenshtein('abcd', 'abc')).toBe(1);
  });

  it('computes single substitution', () => {
    expect(levenshtein('abc', 'axc')).toBe(1);
  });

  it('computes multiple edits', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
});

describe('suggestClosest', () => {
  const candidates = ['executeQuery', 'refresh', 'export'] as const;

  it('returns the closest candidate within edit distance 3', () => {
    expect(suggestClosest('executeQuery2', candidates)).toBe('executeQuery');
    expect(suggestClosest('refrash', candidates)).toBe('refresh');
  });

  it('is case-insensitive', () => {
    expect(suggestClosest('EXECUTEQUERY', candidates)).toBe('executeQuery');
  });

  it('returns undefined when nothing is within edit distance', () => {
    expect(suggestClosest('completely-different', candidates)).toBeUndefined();
  });

  it('respects a custom maxDistance', () => {
    // 'execxteQueryX' is distance 2 from 'executeQuery'.
    expect(suggestClosest('execxteQueryX', candidates, 1)).toBeUndefined();
    expect(suggestClosest('execxteQueryX', candidates, 2)).toBe('executeQuery');
  });
});
