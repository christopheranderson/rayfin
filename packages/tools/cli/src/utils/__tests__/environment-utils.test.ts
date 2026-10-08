import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as userUtils from '../../auth/user-utils.js';
import {
  validateEnvironmentName,
  resolveEnvironment,
  isProductionEnvironment,
} from '../environment-utils.js';
import * as gitUtils from '../git-utils.js';

// Mock the utility modules
vi.mock('../../auth/user-utils.js');
vi.mock('../git-utils.js');

const mockGetCurrentUser = vi.mocked(userUtils.getCurrentUser);
const mockGetCurrentGitInfo = vi.mocked(gitUtils.getCurrentGitInfo);
const mockNormalizeUsername = vi.mocked(userUtils.normalizeUsername);

describe('environment-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateEnvironmentName', () => {
    it('should accept valid environment names', () => {
      expect(() => validateEnvironmentName('dev')).not.toThrow();
      expect(() => validateEnvironmentName('staging')).not.toThrow();
      expect(() => validateEnvironmentName('prod-123')).not.toThrow();
      expect(() => validateEnvironmentName('john-main')).not.toThrow();
      expect(() =>
        validateEnvironmentName('test-environment-123')
      ).not.toThrow();
    });

    it('should reject environment names that are too long', () => {
      const longName = 'a'.repeat(51);
      expect(() => validateEnvironmentName(longName)).toThrow(
        'Environment name too long (max 50 characters)'
      );
    });

    it('should reject environment names with invalid characters', () => {
      expect(() => validateEnvironmentName('test_env')).toThrow(
        'Environment name must contain only lowercase letters, numbers, and hyphens'
      );
      expect(() => validateEnvironmentName('Test-Env')).toThrow(
        'Environment name must contain only lowercase letters, numbers, and hyphens'
      );
      expect(() => validateEnvironmentName('test env')).toThrow(
        'Environment name must contain only lowercase letters, numbers, and hyphens'
      );
      expect(() => validateEnvironmentName('test@env')).toThrow(
        'Environment name must contain only lowercase letters, numbers, and hyphens'
      );
    });

    it('should reject environment names starting or ending with hyphen', () => {
      expect(() => validateEnvironmentName('-test')).toThrow(
        'Environment name cannot start or end with a hyphen'
      );
      expect(() => validateEnvironmentName('test-')).toThrow(
        'Environment name cannot start or end with a hyphen'
      );
      expect(() => validateEnvironmentName('-test-')).toThrow(
        'Environment name cannot start or end with a hyphen'
      );
    });

    it('should reject environment names with sensitive terms', () => {
      expect(() => validateEnvironmentName('password123')).toThrow(
        "Environment name should not contain sensitive terms like 'password'"
      );
      expect(() => validateEnvironmentName('test-secret')).toThrow(
        "Environment name should not contain sensitive terms like 'secret'"
      );
      expect(() => validateEnvironmentName('my-key-env')).toThrow(
        "Environment name should not contain sensitive terms like 'key'"
      );
      expect(() => validateEnvironmentName('tokentest')).toThrow(
        "Environment name should not contain sensitive terms like 'token'"
      );
      expect(() => validateEnvironmentName('pwdtest')).toThrow(
        "Environment name should not contain sensitive terms like 'pwd'"
      );
    });
  });

  describe('resolveEnvironment', () => {
    it('should use custom environment when provided', async () => {
      const result = await resolveEnvironment('custom-env');

      expect(result).toEqual({
        environment: 'custom-env',
        source: 'custom',
        details: { customValue: 'custom-env' },
      });
    });

    it('should sanitize custom environment', async () => {
      const result = await resolveEnvironment('Custom_Env@123!');

      expect(result).toEqual({
        environment: 'customenv123',
        source: 'custom',
        details: { customValue: 'Custom_Env@123!' },
      });
    });

    it('should generate environment from user and git info', async () => {
      mockGetCurrentUser.mockResolvedValue({
        username: 'john.doe',
        email: 'john.doe@contoso.com',
        accountName: 'My Subscription',
      });

      mockNormalizeUsername.mockReturnValue('johndoe');

      mockGetCurrentGitInfo.mockResolvedValue({
        branch: 'feature-branch',
        isGitRepo: true,
        originalBranch: 'feature-branch',
      });

      const result = await resolveEnvironment();

      expect(result).toEqual({
        environment: 'johndoe-feature-branch',
        source: 'user-git',
        details: { username: 'johndoe', branch: 'feature-branch' },
      });
    });

    it('should handle service principal', async () => {
      mockGetCurrentUser.mockResolvedValue({
        username: 'sp',
        email: 'http://service-principal',
        accountName: 'My Subscription',
      });

      mockNormalizeUsername.mockReturnValue('sp');

      mockGetCurrentGitInfo.mockResolvedValue({
        branch: 'main',
        isGitRepo: true,
        originalBranch: 'main',
      });

      const result = await resolveEnvironment();

      expect(result).toEqual({
        environment: 'sp-main',
        source: 'user-git',
        details: { username: 'sp', branch: 'main' },
      });
    });

    it('should throw error when user is not logged in', async () => {
      mockGetCurrentUser.mockRejectedValue(new Error('Not logged in'));

      await expect(resolveEnvironment()).rejects.toThrow(
        "Failed to resolve environment: Not logged in\nPlease provide an environment or ensure you are logged in with 'rayfin login'."
      );
    });
  });

  describe('isProductionEnvironment', () => {
    it('should detect production-like environments', () => {
      expect(isProductionEnvironment('prod')).toBe(true);
      expect(isProductionEnvironment('production')).toBe(true);
      expect(isProductionEnvironment('live')).toBe(true);
      expect(isProductionEnvironment('master')).toBe(true);
      expect(isProductionEnvironment('main')).toBe(true);
      expect(isProductionEnvironment('my-prod-env')).toBe(true);
      expect(isProductionEnvironment('staging-production')).toBe(true);
    });

    it('should not detect non-production environments', () => {
      expect(isProductionEnvironment('dev')).toBe(false);
      expect(isProductionEnvironment('development')).toBe(false);
      expect(isProductionEnvironment('test')).toBe(false);
      expect(isProductionEnvironment('staging')).toBe(false);
      expect(isProductionEnvironment('john-feature')).toBe(false);
      expect(isProductionEnvironment('qa')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(isProductionEnvironment('PROD')).toBe(true);
      expect(isProductionEnvironment('Production')).toBe(true);
      expect(isProductionEnvironment('LIVE')).toBe(true);
      expect(isProductionEnvironment('Master')).toBe(true);
    });
  });
});
