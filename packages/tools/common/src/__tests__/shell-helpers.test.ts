import { describe, it, expect } from 'vitest';

import { shellEscape } from '../shell-helpers';

describe('shellEscape', () => {
  describe('POSIX (non-win32)', () => {
    it('wraps simple value in single quotes', () => {
      expect(shellEscape('hello', 'linux')).toBe("'hello'");
    });

    it('escapes embedded single quotes', () => {
      expect(shellEscape("it's", 'darwin')).toBe("'it'\\''s'");
    });

    it('handles empty string', () => {
      expect(shellEscape('', 'linux')).toBe("''");
    });

    it('preserves spaces and special characters', () => {
      expect(shellEscape('my file (1).txt', 'linux')).toBe("'my file (1).txt'");
    });

    it('falls back to current platform when platform arg is omitted', () => {
      // On any platform, omitting platform should not throw
      const result = shellEscape('test');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('win32', () => {
    it('wraps value in single quotes (PowerShell-safe)', () => {
      expect(shellEscape('hello', 'win32')).toBe("'hello'");
    });

    it('escapes embedded single quotes', () => {
      expect(shellEscape("it's", 'win32')).toBe("'it''s'");
    });

    it('handles empty string', () => {
      expect(shellEscape('', 'win32')).toBe("''");
    });

    it('preserves spaces and special characters', () => {
      expect(shellEscape('C:\\Program Files\\app', 'win32')).toBe(
        "'C:\\Program Files\\app'"
      );
    });

    it('prevents PowerShell variable interpolation', () => {
      expect(shellEscape('$(evil)', 'win32')).toBe("'$(evil)'");
    });
  });
});
