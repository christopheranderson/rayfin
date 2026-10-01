import { describe, it, expect } from 'vitest';

import {
  createAuthConfig,
  validateAuthConfig,
  AuthOptions,
} from '../init-auth-settings-helper.js';

describe('createAuthConfig', () => {
  describe('basic configuration', () => {
    it('should return disabled config when enabled is false', () => {
      const config = createAuthConfig(false);
      expect(config).toEqual({ enabled: false });
    });

    it('should return enabled config with defaults when enabled is true', () => {
      const config = createAuthConfig(true);
      expect(config.enabled).toBe(true);
      expect(config.customClaims).toEqual({ app_version: '1.0.0' });
      expect(config.scopes).toEqual(['read:data', 'write:data']);
      expect(config.email).toBeUndefined();
      expect(config.passwordless).toBeUndefined();
      // Password should be enabled by default
      expect(config.password).toEqual({ enabled: true });
    });
  });

  describe('password configuration', () => {
    it('should include password.enabled=true by default', () => {
      const config = createAuthConfig(true);
      expect(config.password).toEqual({ enabled: true });
    });

    it('should set password.enabled=false when specified', () => {
      const options: AuthOptions = { passwordEnabled: false };
      const config = createAuthConfig(true, false, options);
      expect(config.password).toEqual({ enabled: false });
    });

    it('should set password.enabled=true when specified', () => {
      const options: AuthOptions = { passwordEnabled: true };
      const config = createAuthConfig(true, false, options);
      expect(config.password).toEqual({ enabled: true });
    });
  });

  describe('email configuration', () => {
    it('should include email settings when emailEnabled is true', () => {
      const config = createAuthConfig(true, true);
      expect(config.email).toBeDefined();
      expect(config.email?.enabled).toBe(true);
      expect(config.email?.provider).toBe('smtp');
      expect(config.email?.senderName).toBe('Rayfin Platform');
    });

    it('should not include email settings when emailEnabled is false', () => {
      const config = createAuthConfig(true, false);
      expect(config.email).toBeUndefined();
    });
  });

  describe('passwordless configuration', () => {
    it('should not include passwordless when options are undefined', () => {
      const config = createAuthConfig(true, false);
      expect(config.passwordless).toBeUndefined();
    });

    it('should not include passwordless when magicLinkEnabled is false', () => {
      const options: AuthOptions = {
        passwordless: { magicLinkEnabled: false },
      };
      const config = createAuthConfig(true, false, options);
      expect(config.passwordless).toBeUndefined();
    });

    it('should include passwordless config when magicLinkEnabled is true', () => {
      const options: AuthOptions = { passwordless: { magicLinkEnabled: true } };
      const config = createAuthConfig(true, false, options);
      expect(config.passwordless).toBeDefined();
      expect(config.passwordless?.magicLink?.enabled).toBe(true);
      expect(config.passwordless?.magicLink?.expiryMinutes).toBe(15); // default
    });

    it('should use custom expiryMinutes when provided', () => {
      const options: AuthOptions = {
        passwordless: {
          magicLinkEnabled: true,
          expiryMinutes: 30,
        },
      };
      const config = createAuthConfig(true, false, options);
      expect(config.passwordless?.magicLink?.expiryMinutes).toBe(30);
    });

    it('should include allowedRedirectUris when provided', () => {
      const options: AuthOptions = {
        passwordless: {
          magicLinkEnabled: true,
        },
        allowedRedirectUris: ['http://localhost:3000', 'https://example.com'],
      };
      const config = createAuthConfig(true, false, options);
      expect(config.allowedRedirectUris).toEqual([
        'http://localhost:3000',
        'https://example.com',
      ]);
    });

    it('should default allowedRedirectUris to localhost when empty array', () => {
      const options: AuthOptions = {
        passwordless: {
          magicLinkEnabled: true,
        },
        allowedRedirectUris: [],
      };
      const config = createAuthConfig(true, false, options);
      expect(config.allowedRedirectUris).toBeUndefined();
    });

    it('should write allowedRedirectUris at top-level auth, not under magicLink', () => {
      const options: AuthOptions = {
        passwordless: {
          magicLinkEnabled: true,
        },
        allowedRedirectUris: ['https://example.com/callback'],
      };
      const config = createAuthConfig(true, false, options);
      expect(config.allowedRedirectUris).toEqual([
        'https://example.com/callback',
      ]);
      // magicLink should not have redirect URIs (they live at top-level now)
      expect(
        (config.passwordless?.magicLink as any)?.allowedRedirectUris
      ).toBeUndefined();
    });
  });

  describe('combined password and passwordless configuration', () => {
    it('should support passwordless-only mode (password disabled, magic link enabled)', () => {
      const options: AuthOptions = {
        passwordEnabled: false,
        passwordless: { magicLinkEnabled: true },
      };
      const config = createAuthConfig(true, false, options);
      expect(config.password).toEqual({ enabled: false });
      expect(config.passwordless?.magicLink?.enabled).toBe(true);
    });

    it('should support both methods enabled', () => {
      const options: AuthOptions = {
        passwordEnabled: true,
        passwordless: { magicLinkEnabled: true },
      };
      const config = createAuthConfig(true, false, options);
      expect(config.password).toEqual({ enabled: true });
      expect(config.passwordless?.magicLink?.enabled).toBe(true);
    });
  });

  describe('fabric configuration', () => {
    it('should include fabric config when fabricEnabled is true', () => {
      const options: AuthOptions = { fabricEnabled: true };
      const config = createAuthConfig(true, false, options);
      expect(config.fabric).toEqual({ enabled: true });
    });

    it('should not include fabric config when fabricEnabled is false', () => {
      const options: AuthOptions = { fabricEnabled: false };
      const config = createAuthConfig(true, false, options);
      expect(config.fabric).toBeUndefined();
    });

    it('should not include fabric config when fabricEnabled is not specified', () => {
      const options: AuthOptions = {};
      const config = createAuthConfig(true, false, options);
      expect(config.fabric).toBeUndefined();
    });

    it('should support fabric with other auth methods', () => {
      const options: AuthOptions = {
        passwordEnabled: true,
        passwordless: { magicLinkEnabled: true },
        fabricEnabled: true,
      };
      const config = createAuthConfig(true, false, options);
      expect(config.password).toEqual({ enabled: true });
      expect(config.passwordless?.magicLink?.enabled).toBe(true);
      expect(config.fabric).toEqual({ enabled: true });
    });
  });
});

describe('validateAuthConfig', () => {
  describe('disabled auth', () => {
    it('should return valid for disabled auth', () => {
      const result = validateAuthConfig({ enabled: false });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('magic link without email', () => {
    it('should return error when magic link enabled but email disabled', () => {
      const result = validateAuthConfig({
        enabled: true,
        passwordless: {
          magicLink: {
            enabled: true,
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe(
        'services.auth.passwordless.magicLink.enabled'
      );
      expect(result.errors[0].message).toContain(
        'Magic link authentication requires email'
      );
    });

    it('should not return error when magic link enabled and email enabled', () => {
      const result = validateAuthConfig({
        enabled: true,
        email: {
          enabled: true,
          provider: 'smtp',
          senderName: 'Test',
          verificationTokenExpirationHours: 24,
          passwordResetTokenExpirationMinutes: 30,
        },
        passwordless: {
          magicLink: {
            enabled: true,
          },
        },
      });
      expect(result.errors.filter((e) => e.message.includes('email'))).toEqual(
        []
      );
    });
  });

  describe('redirect URI validation', () => {
    it('should return error for invalid URLs at top-level', () => {
      const result = validateAuthConfig({
        enabled: true,
        allowedRedirectUris: ['not-a-url', 'also invalid'],
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.filter((e) => e.message.includes('Invalid redirect URI'))
      ).toHaveLength(2);
      expect(result.errors[0].field).toBe('services.auth.allowedRedirectUris');
    });

    it('should return error for HTTP non-localhost URLs at top-level', () => {
      const result = validateAuthConfig({
        enabled: true,
        allowedRedirectUris: ['http://example.com/callback'],
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.filter((e) => e.message.includes('must use HTTPS'))
      ).toHaveLength(1);
    });

    it('should allow HTTP for localhost at top-level', () => {
      const result = validateAuthConfig({
        enabled: true,
        allowedRedirectUris: ['http://localhost:3000/callback'],
      });
      expect(
        result.errors.filter((e) => e.message.includes('must use HTTPS'))
      ).toHaveLength(0);
    });

    it('should allow HTTP for 127.0.0.1 at top-level', () => {
      const result = validateAuthConfig({
        enabled: true,
        allowedRedirectUris: ['http://127.0.0.1:5000'],
      });
      expect(
        result.errors.filter((e) => e.message.includes('must use HTTPS'))
      ).toHaveLength(0);
    });

    it('should allow HTTPS URLs at top-level', () => {
      const result = validateAuthConfig({
        enabled: true,
        allowedRedirectUris: ['https://myapp.com'],
      });
      expect(
        result.errors.filter((e) => e.message.includes('redirect'))
      ).toHaveLength(0);
    });
  });

  describe('expiry minutes validation', () => {
    it('should return error for zero expiry', () => {
      const result = validateAuthConfig({
        enabled: true,
        email: {
          enabled: true,
          provider: 'smtp',
          senderName: 'Test',
          verificationTokenExpirationHours: 24,
          passwordResetTokenExpirationMinutes: 30,
        },
        passwordless: {
          magicLink: {
            enabled: true,
            expiryMinutes: 0,
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.filter((e) => e.message.includes('expiry'))
      ).toHaveLength(1);
    });

    it('should return error for negative expiry', () => {
      const result = validateAuthConfig({
        enabled: true,
        email: {
          enabled: true,
          provider: 'smtp',
          senderName: 'Test',
          verificationTokenExpirationHours: 24,
          passwordResetTokenExpirationMinutes: 30,
        },
        passwordless: {
          magicLink: {
            enabled: true,
            expiryMinutes: -5,
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.filter((e) => e.message.includes('expiry'))
      ).toHaveLength(1);
    });
  });

  describe('warnings', () => {
    it('should warn when both passwordless and email are disabled', () => {
      const result = validateAuthConfig({
        enabled: true,
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('passwordless');
      expect(result.warnings[0]).toContain('email');
    });

    it('should not warn when email is enabled', () => {
      const result = validateAuthConfig({
        enabled: true,
        email: {
          enabled: true,
          provider: 'smtp',
          senderName: 'Test',
          verificationTokenExpirationHours: 24,
          passwordResetTokenExpirationMinutes: 30,
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('should not warn when magic link is enabled', () => {
      const result = validateAuthConfig({
        enabled: true,
        email: {
          enabled: true,
          provider: 'smtp',
          senderName: 'Test',
          verificationTokenExpirationHours: 24,
          passwordResetTokenExpirationMinutes: 30,
        },
        passwordless: {
          magicLink: {
            enabled: true,
          },
        },
      });
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('multiple errors', () => {
    it('should collect all errors', () => {
      const result = validateAuthConfig({
        enabled: true,
        allowedRedirectUris: ['not-a-url', 'http://example.com'],
        passwordless: {
          magicLink: {
            enabled: true,
            expiryMinutes: -1,
          },
        },
      });
      expect(result.valid).toBe(false);
      // Should have: email required, invalid URL, HTTPS required, negative expiry
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });
});
