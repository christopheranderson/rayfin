import { describe, it, expect } from 'vitest';

import { isGitUrl } from '../types';

describe('isGitUrl', () => {
  describe('accepts valid git URLs', () => {
    it('accepts https:// with host', () => {
      expect(isGitUrl('https://github.com/org/repo.git')).toBe(true);
    });

    it('accepts git@ (SSH shorthand)', () => {
      expect(isGitUrl('git@github.com:org/repo.git')).toBe(true);
    });

    it('accepts ssh://', () => {
      expect(isGitUrl('ssh://git@github.com/org/repo.git')).toBe(true);
    });

    it('accepts file://', () => {
      expect(isGitUrl('file:///home/user/templates')).toBe(true);
    });
  });

  describe('rejects invalid inputs', () => {
    it('rejects http:// (insecure)', () => {
      expect(isGitUrl('http://github.com/org/repo.git')).toBe(false);
    });

    it('rejects bare https:// with no host', () => {
      expect(isGitUrl('https://')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isGitUrl('')).toBe(false);
    });

    it('rejects plain names', () => {
      expect(isGitUrl('my-template')).toBe(false);
    });

    it('rejects relative paths', () => {
      expect(isGitUrl('./my-template')).toBe(false);
    });

    it('rejects null/undefined', () => {
      expect(isGitUrl(null as unknown as string)).toBe(false);
      expect(isGitUrl(undefined as unknown as string)).toBe(false);
    });

    it('rejects ftp://', () => {
      expect(isGitUrl('ftp://example.com/repo.git')).toBe(false);
    });
  });

  it('trims whitespace before checking', () => {
    expect(isGitUrl('  https://github.com/org/repo.git  ')).toBe(true);
  });
});
