import { describe, it, expect } from 'vitest';

import { isValidEmail, EMAIL_REGEX } from '../utils/email';

describe('isValidEmail', () => {
  describe('valid emails', () => {
    it('should accept standard email format', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
    });

    it('should accept email with subdomain', () => {
      expect(isValidEmail('user@mail.example.com')).toBe(true);
    });

    it('should accept email with multiple subdomains', () => {
      expect(isValidEmail('user@mail.corp.example.com')).toBe(true);
    });

    it('should accept email with numbers', () => {
      expect(isValidEmail('user123@example.com')).toBe(true);
    });

    it('should accept email with dots in local part', () => {
      expect(isValidEmail('first.last@example.com')).toBe(true);
    });

    it('should accept email with hyphens in local part', () => {
      expect(isValidEmail('user-name@example.com')).toBe(true);
    });

    it('should accept email with underscores in local part', () => {
      expect(isValidEmail('user_name@example.com')).toBe(true);
    });

    it('should accept email with hyphens in domain', () => {
      expect(isValidEmail('user@my-domain.com')).toBe(true);
    });

    it('should accept email with long TLD', () => {
      expect(isValidEmail('user@example.museum')).toBe(true);
    });

    it('should accept email with two-letter TLD', () => {
      expect(isValidEmail('user@example.io')).toBe(true);
    });

    it('should accept email with mixed case', () => {
      expect(isValidEmail('User@Example.COM')).toBe(true);
    });
  });

  describe('invalid emails', () => {
    it('should reject email without @', () => {
      expect(isValidEmail('userexample.com')).toBe(false);
    });

    it('should reject email without domain', () => {
      expect(isValidEmail('user@')).toBe(false);
    });

    it('should reject email without local part', () => {
      expect(isValidEmail('@example.com')).toBe(false);
    });

    it('should reject email without TLD', () => {
      expect(isValidEmail('user@example')).toBe(false);
    });

    it('should reject email with spaces', () => {
      expect(isValidEmail('user name@example.com')).toBe(false);
    });

    it('should reject email with multiple @', () => {
      expect(isValidEmail('user@@example.com')).toBe(false);
    });

    it('should reject email with @ at the end', () => {
      expect(isValidEmail('user@example.com@')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidEmail('')).toBe(false);
    });

    it('should reject email with only spaces', () => {
      expect(isValidEmail('   ')).toBe(false);
    });

    it('should reject email with special characters in domain', () => {
      expect(isValidEmail('user@exam!ple.com')).toBe(false);
    });

    it('should reject email with consecutive dots in local part', () => {
      expect(isValidEmail('user..name@example.com')).toBe(false);
    });

    it('should reject email starting with dot', () => {
      expect(isValidEmail('.user@example.com')).toBe(false);
    });

    it('should reject email ending with dot before @', () => {
      expect(isValidEmail('user.@example.com')).toBe(false);
    });

    it('should reject email with single letter TLD', () => {
      expect(isValidEmail('user@example.c')).toBe(false);
    });

    it('should reject email with missing domain extension', () => {
      expect(isValidEmail('user@.com')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should reject null by throwing error', () => {
      expect(() => isValidEmail(null as any)).toThrow();
    });

    it('should reject undefined by throwing error', () => {
      expect(() => isValidEmail(undefined as any)).toThrow();
    });

    it('should handle very long email addresses', () => {
      const longEmail = 'a'.repeat(50) + '@' + 'b'.repeat(50) + '.com';
      expect(isValidEmail(longEmail)).toBe(true);
    });
  });
});

describe('EMAIL_REGEX', () => {
  it('should be a valid RegExp', () => {
    expect(EMAIL_REGEX).toBeInstanceOf(RegExp);
  });

  it('should match valid email directly', () => {
    expect(EMAIL_REGEX.test('user@example.com')).toBe(true);
  });

  it('should not match invalid email directly', () => {
    expect(EMAIL_REGEX.test('invalid-email')).toBe(false);
  });
});
