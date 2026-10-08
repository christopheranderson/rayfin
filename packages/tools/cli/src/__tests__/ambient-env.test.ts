import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  hasAmbientToken,
  getAmbientToken,
  getAmbientWorkspaceId,
  getAmbientTenantId,
} from '../utils/ambient-env.js';

describe('ambient-env', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv['RAYFIN_TOKEN'] = process.env['RAYFIN_TOKEN'];
    savedEnv['RAYFIN_WORKSPACE_ID'] = process.env['RAYFIN_WORKSPACE_ID'];
    savedEnv['RAYFIN_TENANT_ID'] = process.env['RAYFIN_TENANT_ID'];
    delete process.env['RAYFIN_TOKEN'];
    delete process.env['RAYFIN_WORKSPACE_ID'];
    delete process.env['RAYFIN_TENANT_ID'];
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('hasAmbientToken', () => {
    it('returns false when RAYFIN_TOKEN is not set', () => {
      expect(hasAmbientToken()).toBe(false);
    });

    it('returns true when RAYFIN_TOKEN is set', () => {
      process.env['RAYFIN_TOKEN'] = 'test-token-123';
      expect(hasAmbientToken()).toBe(true);
    });

    it('returns false when RAYFIN_TOKEN is empty string', () => {
      process.env['RAYFIN_TOKEN'] = '';
      expect(hasAmbientToken()).toBe(false);
    });
  });

  describe('getAmbientToken', () => {
    it('returns null when RAYFIN_TOKEN is not set', () => {
      expect(getAmbientToken()).toBeNull();
    });

    it('returns the token value when set', () => {
      process.env['RAYFIN_TOKEN'] = 'my-bearer-token';
      expect(getAmbientToken()).toBe('my-bearer-token');
    });

    it('strips Bearer prefix from token', () => {
      process.env['RAYFIN_TOKEN'] = 'Bearer ey12345';
      expect(getAmbientToken()).toBe('ey12345');
    });

    it('strips bearer prefix case-insensitively', () => {
      process.env['RAYFIN_TOKEN'] = 'bearer ey12345';
      expect(getAmbientToken()).toBe('ey12345');
    });
  });

  describe('getAmbientWorkspaceId', () => {
    it('returns null when RAYFIN_WORKSPACE_ID is not set', () => {
      expect(getAmbientWorkspaceId()).toBeNull();
    });

    it('returns the workspace ID when set', () => {
      process.env['RAYFIN_WORKSPACE_ID'] = 'ws-abc-123';
      expect(getAmbientWorkspaceId()).toBe('ws-abc-123');
    });

    it('returns null when RAYFIN_WORKSPACE_ID is empty string', () => {
      process.env['RAYFIN_WORKSPACE_ID'] = '';
      expect(getAmbientWorkspaceId()).toBeNull();
    });
  });

  describe('getAmbientTenantId', () => {
    it('returns null when RAYFIN_TENANT_ID is not set', () => {
      expect(getAmbientTenantId()).toBeNull();
    });

    it('returns the tenant ID when set', () => {
      process.env['RAYFIN_TENANT_ID'] = 'tenant-abc-123';
      expect(getAmbientTenantId()).toBe('tenant-abc-123');
    });

    it('returns null when RAYFIN_TENANT_ID is empty string', () => {
      process.env['RAYFIN_TENANT_ID'] = '';
      expect(getAmbientTenantId()).toBeNull();
    });
  });
});
