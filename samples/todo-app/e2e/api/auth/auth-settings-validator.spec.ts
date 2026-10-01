import { describe, it, expect, beforeAll } from 'vitest';

import { ensureBackendRunning, getBackendUrl } from '../../shared/backend';

const HEADERS = {
  'x-rayfin-publishable-key': 'pk-commonSampleAppPKkey',
  'Content-Type': 'application/json',
};

/** Valid baseline settings to restore after each destructive test */
const VALID_SETTINGS = {
  auth: {
    enabled: true,
    password: { enabled: true },
    fabric: { enabled: false },
    scopes: ['read:data', 'write:data'],
    expiryInMinutes: 60,
    refreshToken: { lifetimeInDays: 90, absoluteLifetimeInMinutes: -1 },
  },
  data: { dialect: 'postgresql', enabled: true },
  storage: { enabled: false },
};

describe('AuthSettingsValidator E2E Tests', () => {
  let settingsEndpoint: string;

  beforeAll(async () => {
    await ensureBackendRunning();
    settingsEndpoint = `${getBackendUrl()}/api/projectRuntimeSettings`;
  });

  it('rejects settings when auth.enabled is false', async () => {
    const body = {
      ...VALID_SETTINGS,
      auth: { ...VALID_SETTINGS.auth, enabled: false },
    };

    const response = await fetch(settingsEndpoint, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe('INVALID_INPUT');
    expect(json.message).toContain('Auth Settings need to be enabled');
  });

  it('rejects settings when no auth type is enabled', async () => {
    const body = {
      ...VALID_SETTINGS,
      auth: {
        ...VALID_SETTINGS.auth,
        enabled: true,
        password: { enabled: false },
        fabric: { enabled: false },
      },
    };

    const response = await fetch(settingsEndpoint, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe('INVALID_INPUT');
    expect(json.message).toContain('At least one auth type must be enabled');
  });

  it('accepts settings when password auth is enabled', async () => {
    const response = await fetch(settingsEndpoint, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(VALID_SETTINGS),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.auth.enabled).toBe(true);
    expect(json.auth.password.enabled).toBe(true);
  });

  it('accepts settings when fabric auth is enabled', async () => {
    const body = {
      ...VALID_SETTINGS,
      auth: {
        ...VALID_SETTINGS.auth,
        password: { enabled: false },
        fabric: { enabled: true },
      },
    };

    const response = await fetch(settingsEndpoint, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.auth.fabric.enabled).toBe(true);

    // Restore password auth for other tests
    await fetch(settingsEndpoint, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(VALID_SETTINGS),
    });
  });
});
