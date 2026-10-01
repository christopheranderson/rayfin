import { describe, it, expect } from 'vitest';

import {
  normalizePath,
  ensureTrailingSlash,
  removeTrailingSlash,
  combinePaths,
} from '../utils/path-utils';

describe('Path Utilities', () => {
  describe('normalizePath', () => {
    it('should convert backslashes to forward slashes', () => {
      expect(normalizePath('C:\\Users\\test\\project')).toBe(
        'C:/Users/test/project'
      );
    });

    it('should handle paths with mixed slashes', () => {
      expect(normalizePath('C:/Users\\test/project')).toBe(
        'C:/Users/test/project'
      );
    });

    it('should leave paths with only forward slashes unchanged', () => {
      expect(normalizePath('/home/user/project')).toBe('/home/user/project');
    });

    it('should handle empty strings', () => {
      expect(normalizePath('')).toBe('');
    });
  });

  describe('ensureTrailingSlash', () => {
    it('should add a trailing slash if missing', () => {
      expect(ensureTrailingSlash('/home/user/project')).toBe(
        '/home/user/project/'
      );
    });

    it('should not add a trailing slash if already present', () => {
      expect(ensureTrailingSlash('/home/user/project/')).toBe(
        '/home/user/project/'
      );
    });

    it('should normalize backslashes first', () => {
      expect(ensureTrailingSlash('C:\\Users\\test')).toBe('C:/Users/test/');
    });
  });

  describe('removeTrailingSlash', () => {
    it('should remove a trailing slash if present', () => {
      expect(removeTrailingSlash('/home/user/project/')).toBe(
        '/home/user/project'
      );
    });

    it('should not modify a path without a trailing slash', () => {
      expect(removeTrailingSlash('/home/user/project')).toBe(
        '/home/user/project'
      );
    });

    it('should normalize backslashes first', () => {
      expect(removeTrailingSlash('C:\\Users\\test\\')).toBe('C:/Users/test');
    });
  });

  describe('combinePaths', () => {
    it('should combine path segments with forward slashes', () => {
      expect(combinePaths('home', 'user', 'project')).toBe('home/user/project');
    });

    it('should normalize backslashes in segments', () => {
      expect(combinePaths('C:\\Users', 'test\\project')).toBe(
        'C:/Users/test/project'
      );
    });

    it('should handle segments with leading/trailing slashes', () => {
      expect(combinePaths('/home/', '/user/', '/project/')).toBe(
        '/home/user/project/'
      );
    });

    it('should deduplicate consecutive slashes', () => {
      expect(combinePaths('home/', '/user/', '/project')).toBe(
        'home/user/project'
      );
    });
  });
});
