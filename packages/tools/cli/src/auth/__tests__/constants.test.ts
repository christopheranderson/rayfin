import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AUTHORITY_HOST,
  DEFAULT_FABRIC_SCOPE,
  DEFAULT_RAYFIN_CLIENT_ID,
  getAuthorityHost,
  getDefaultAuthority,
  getFabricScope,
  getFabricScopes,
  getRayfinClientId,
  getTenantAuthority,
} from '../constants.js';

const ENV_KEYS = [
  'RAYFIN_AUTHORITY_HOST',
  'RAYFIN_CLIENT_ID',
  'RAYFIN_FABRIC_SCOPE',
] as const;

describe('auth/constants resolvers', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  describe('getRayfinClientId', () => {
    it('returns the built-in default when env var is unset', () => {
      expect(getRayfinClientId()).toBe(DEFAULT_RAYFIN_CLIENT_ID);
    });

    it('returns the env var value when set', () => {
      process.env['RAYFIN_CLIENT_ID'] = 'override-client-id';
      expect(getRayfinClientId()).toBe('override-client-id');
    });

    it('falls back to default when env var is set to empty string', () => {
      process.env['RAYFIN_CLIENT_ID'] = '';
      expect(getRayfinClientId()).toBe(DEFAULT_RAYFIN_CLIENT_ID);
    });
  });

  describe('getAuthorityHost', () => {
    it('returns the built-in default when env var is unset', () => {
      expect(getAuthorityHost()).toBe(DEFAULT_AUTHORITY_HOST);
    });

    it('returns the env var value when set', () => {
      process.env['RAYFIN_AUTHORITY_HOST'] = 'https://login.example.invalid';
      expect(getAuthorityHost()).toBe('https://login.example.invalid');
    });

    it('strips trailing slashes so callers can safely concatenate /<tenant>', () => {
      process.env['RAYFIN_AUTHORITY_HOST'] = 'https://login.example.invalid///';
      expect(getAuthorityHost()).toBe('https://login.example.invalid');
    });
  });

  describe('getFabricScope', () => {
    it('returns the built-in default when env var is unset', () => {
      expect(getFabricScope()).toBe(DEFAULT_FABRIC_SCOPE);
    });

    it('returns the env var value when set', () => {
      process.env['RAYFIN_FABRIC_SCOPE'] =
        'https://example.invalid/api/.default';
      expect(getFabricScope()).toBe('https://example.invalid/api/.default');
    });
  });

  describe('getDefaultAuthority / getTenantAuthority', () => {
    it('builds a multi-tenant authority URL from the resolved host', () => {
      expect(getDefaultAuthority()).toBe(`${DEFAULT_AUTHORITY_HOST}/common`);
    });

    it('builds a tenant-specific authority URL from the resolved host', () => {
      expect(getTenantAuthority('contoso')).toBe(
        `${DEFAULT_AUTHORITY_HOST}/contoso`
      );
    });

    it('respects RAYFIN_AUTHORITY_HOST overrides at call time', () => {
      process.env['RAYFIN_AUTHORITY_HOST'] = 'https://login.example.invalid';
      expect(getDefaultAuthority()).toBe(
        'https://login.example.invalid/common'
      );
      expect(getTenantAuthority('contoso')).toBe(
        'https://login.example.invalid/contoso'
      );
    });
  });

  describe('getFabricScopes', () => {
    it('returns a single-element array of the resolved scope', () => {
      expect(getFabricScopes()).toEqual([DEFAULT_FABRIC_SCOPE]);
    });

    it('reflects RAYFIN_FABRIC_SCOPE overrides at call time', () => {
      process.env['RAYFIN_FABRIC_SCOPE'] = 'https://other.invalid/.default';
      expect(getFabricScopes()).toEqual(['https://other.invalid/.default']);
    });
  });
});
