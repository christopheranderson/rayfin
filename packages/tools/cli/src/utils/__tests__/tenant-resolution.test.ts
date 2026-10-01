import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resolveEffectiveTenantId } from '../tenant-resolution.js';

describe('resolveEffectiveTenantId', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['RAYFIN_TENANT_ID'];
    delete process.env['RAYFIN_TENANT_ID'];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['RAYFIN_TENANT_ID'];
    } else {
      process.env['RAYFIN_TENANT_ID'] = savedEnv;
    }
  });

  it('returns the --tenant flag value when provided, ignoring env var and authState', () => {
    process.env['RAYFIN_TENANT_ID'] = 'env-tenant';
    expect(resolveEffectiveTenantId('flag-tenant', 'auth-tenant')).toBe(
      'flag-tenant'
    );
  });

  it('returns the env var when --tenant flag is unset', () => {
    process.env['RAYFIN_TENANT_ID'] = 'env-tenant';
    expect(resolveEffectiveTenantId(undefined, 'auth-tenant')).toBe(
      'env-tenant'
    );
  });

  it('falls back to authState tenant when --tenant and env var are unset', () => {
    expect(resolveEffectiveTenantId(undefined, 'auth-tenant')).toBe(
      'auth-tenant'
    );
  });

  it('returns undefined when no source supplies a tenant', () => {
    expect(resolveEffectiveTenantId(undefined, undefined)).toBeUndefined();
  });

  it('treats empty-string env var as unset and falls back to authState', () => {
    process.env['RAYFIN_TENANT_ID'] = '';
    expect(resolveEffectiveTenantId(undefined, 'auth-tenant')).toBe(
      'auth-tenant'
    );
  });

  it('uses env var when authState tenant is undefined', () => {
    process.env['RAYFIN_TENANT_ID'] = 'env-tenant';
    expect(resolveEffectiveTenantId(undefined, undefined)).toBe('env-tenant');
  });
});
