import { Auth, type AuthOptions } from '@microsoft/rayfin-auth';
import { ApiClient } from '@microsoft/rayfin-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signInWithBrokeredToken } from '../index';

const instances: Auth[] = [];

function tokens(
  user = 'alice',
  refreshToken: string | null = 'RAYFIN-REFRESH'
) {
  return {
    accessToken: `e30.${btoa(JSON.stringify({ sub: user, email: `${user}@example.com` }))}.signature`,
    tokenType: 'Bearer',
    expiresIn: 3600,
    refreshToken,
  };
}

function setup(options: AuthOptions = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = new ApiClient({
    baseUrl: 'http://localhost:5168',
    publishableKey: 'public-key',
    fetch,
  });
  const auth = new Auth(client, {
    storage: false,
    autoRefreshToken: false,
    ...options,
  });
  instances.push(auth);
  return { auth, fetch };
}

afterEach(() => {
  instances.splice(0).forEach((auth) => auth.destroy());
  vi.restoreAllMocks();
});

describe('signInWithBrokeredToken', () => {
  it('installs an already-exchanged token response without making a network request', async () => {
    const { auth, fetch } = setup();
    const login = vi.fn();
    auth.on('AUTH_LOGIN', login);

    const session = await signInWithBrokeredToken(auth, tokens());

    expect(fetch).not.toHaveBeenCalled();
    expect(login).toHaveBeenCalledTimes(1);
    expect(session).toMatchObject({
      isAuthenticated: true,
      user: { id: 'alice' },
    });
    expect(session).toEqual(auth.getSession());
    expect(auth.hasRefreshToken()).toBe(true);
  });

  it('works against a plain-HTTP backend, unlike signInWithEntraToken', async () => {
    const { auth } = setup();

    await expect(
      signInWithBrokeredToken(auth, tokens())
    ).resolves.toMatchObject({ isAuthenticated: true });
  });

  it.each([
    undefined,
    null,
    {},
    { ...tokens(), accessToken: '' },
    { ...tokens(), accessToken: 42 },
    { ...tokens(), tokenType: 'Basic' },
    { ...tokens(), expiresIn: 0 },
    { ...tokens(), expiresIn: -1 },
    { ...tokens(), refreshToken: 123 },
    { ...tokens(), scope: [] },
  ] as any[])(
    'rejects malformed token responses %# without installing a session',
    async (value) => {
      const { auth } = setup();
      const login = vi.fn();
      auth.on('AUTH_LOGIN', login);

      await expect(signInWithBrokeredToken(auth, value)).rejects.toMatchObject({
        code: 'INVALID_TOKEN_RESPONSE',
      });
      expect(login).not.toHaveBeenCalled();
      expect(auth.getSession().isAuthenticated).toBe(false);
    }
  );

  it('replaces an existing session, never returning it as explicit success on failure', async () => {
    const { auth } = setup();
    await signInWithBrokeredToken(auth, tokens('alice'));

    await expect(
      signInWithBrokeredToken(auth, undefined as never)
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN_RESPONSE' });

    expect(auth.getSession()).toMatchObject({ user: { id: 'alice' } });
  });
});
