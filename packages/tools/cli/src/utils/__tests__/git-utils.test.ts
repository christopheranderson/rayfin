import { execSync } from 'child_process';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { getCurrentGitInfo, normalizeBranchName } from '../git-utils.js';

// Mock execSync
vi.mock('child_process');
const mockExecSync = vi.mocked(execSync);

describe('git-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCurrentGitInfo', () => {
    it('should parse branch name correctly', async () => {
      mockExecSync
        .mockReturnValueOnce('') // git rev-parse --git-dir (success)
        .mockReturnValueOnce('feature-branch\n'); // git branch --show-current

      const result = await getCurrentGitInfo();

      expect(result).toEqual({
        branch: 'feature-branch',
        isGitRepo: true,
        originalBranch: 'feature-branch',
      });
    });

    it('should handle nested branch names', async () => {
      mockExecSync
        .mockReturnValueOnce('') // git rev-parse --git-dir
        .mockReturnValueOnce('dev/kywhi/new-feature\n'); // git branch --show-current

      const result = await getCurrentGitInfo();

      expect(result).toEqual({
        branch: 'new-feature',
        isGitRepo: true,
        originalBranch: 'dev/kywhi/new-feature',
      });
    });

    it('should handle main branch', async () => {
      mockExecSync
        .mockReturnValueOnce('') // git rev-parse --git-dir
        .mockReturnValueOnce('main\n'); // git branch --show-current

      const result = await getCurrentGitInfo();

      expect(result).toEqual({
        branch: 'main',
        isGitRepo: true,
        originalBranch: 'main',
      });
    });

    it('should return default when not in git repo', async () => {
      const error = new Error('not a git repository');
      mockExecSync.mockImplementation(() => {
        throw error;
      });

      const result = await getCurrentGitInfo();

      expect(result).toEqual({
        branch: 'default',
        isGitRepo: false,
      });
    });

    it('should handle empty branch name', async () => {
      mockExecSync
        .mockReturnValueOnce('') // git rev-parse --git-dir
        .mockReturnValueOnce(''); // git branch --show-current (empty)

      const result = await getCurrentGitInfo();

      expect(result).toEqual({
        branch: 'default',
        isGitRepo: false,
      });
    });
  });

  describe('normalizeBranchName', () => {
    it('should normalize branch names correctly', () => {
      expect(normalizeBranchName('feature-branch')).toBe('feature-branch');
      expect(normalizeBranchName('dev/feature')).toBe('devfeature');
      expect(normalizeBranchName('MAIN')).toBe('main');
      expect(normalizeBranchName('fix_bug-123')).toBe('fixbug-123');
      expect(normalizeBranchName('hotfix/urgent.fix')).toBe('hotfixurgentfix');
    });

    it('should handle special characters', () => {
      expect(normalizeBranchName('feature@v1.0')).toBe('featurev10');
      expect(normalizeBranchName('user/feature#123')).toBe('userfeature123');
      expect(normalizeBranchName('test branch name')).toBe('testbranchname');
    });

    it('should handle empty string', () => {
      expect(normalizeBranchName('')).toBe('');
    });
  });
});
