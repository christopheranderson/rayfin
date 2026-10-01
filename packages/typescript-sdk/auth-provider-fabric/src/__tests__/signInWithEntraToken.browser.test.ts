import { Auth } from '@microsoft/rayfin-auth';
import { ApiClient } from '@microsoft/rayfin-lib';
import { expect, it, vi } from 'vitest';

import { signInWithEntraToken } from '../index';

it('persists through browser Auth storage and retries data 401 with only Rayfin credentials', async () => {
  const baseUrl = 'https://fabric.example/workload/backend';
  const tokenResponse = {
    accessToken: 'RAYFIN-ACCESS',
    refreshToken: 'RAYFIN-REFRESH',
    expiresIn: 3600,
    tokenType: 'Bearer',
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(tokenResponse))
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(
      Response.json({ ...tokenResponse, accessToken: 'RAYFIN-REFRESHED' })
    )
    .mockResolvedValueOnce(Response.json({ ok: true }));
  const client = new ApiClient({ baseUrl, publishableKey: 'key', fetch });
  const auth = new Auth(client, { storageKeyPrefix: 'direct-entra-test' });
  try {
    const login = vi.fn();
    auth.on('AUTH_LOGIN', login);
    await signInWithEntraToken(auth, { entraToken: 'ENTRA-SECRET' });
    expect(login).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('direct-entra-test_authSession')).toContain(
      'RAYFIN-ACCESS'
    );
    expect(localStorage.getItem('direct-entra-test_authSession')).not.toContain(
      'ENTRA-SECRET'
    );
    await expect(client.get('/data')).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}/api/auth/v1/brokered/token`,
      `${baseUrl}/data`,
      `${baseUrl}/api/auth/v1/token`,
      `${baseUrl}/data`,
    ]);
    expect(
      fetch.mock.calls.map(([, request]) =>
        new Headers(request?.headers).get('Authorization')
      )
    ).toEqual([
      'Bearer ENTRA-SECRET',
      'Bearer RAYFIN-ACCESS',
      'Bearer RAYFIN-ACCESS',
      'Bearer RAYFIN-REFRESHED',
    ]);
  } finally {
    auth.destroy();
    localStorage.removeItem('direct-entra-test_authSession');
  }
});
