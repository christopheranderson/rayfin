import type { Auth } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getCurrentContext,
  setCurrentContext,
} from '../../telemetry/context-store.js';
import { createCliHttp } from '../http.js';

describe('createCliHttp', () => {
  afterEach(() => {
    setCurrentContext(undefined);
    vi.unstubAllGlobals();
  });

  it('records Fabric root activity IDs from authenticated responses', async () => {
    const response = new Response(null, {
      headers: { 'x-ms-root-activity-id': 'activity-1' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const auth: Auth = {
      getToken: vi.fn().mockResolvedValue({ token: 'token' }),
    };
    const context = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(context);

    await expect(
      createCliHttp(auth, ['scope']).fetch('https://api.fabric.test/v1')
    ).resolves.toBe(response);

    expect(getCurrentContext()).toBe(context);
    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["activity-1"]');
  });
});
