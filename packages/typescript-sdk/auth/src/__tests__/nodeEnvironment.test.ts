// @vitest-environment node
import { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { Auth } from '..';

// This suite runs under Vitest's bare `node` environment (see the
// `@vitest-environment node` pragma above), overriding the package-wide
// `jsdom` default. Unlike isomorphic.test.ts — which only deletes
// `globalThis.window` — here `window`, `document`, `navigator`, and
// `localStorage` are ALL genuinely undefined, exactly like a Node server,
// an SSR render pass, or an edge/worker runtime. It proves the Auth SDK's
// `typeof ... !== 'undefined'` guards hold when the entire DOM surface is
// absent and that it never throws a ReferenceError on construction or use.

// Minimal fetch mock covering the auth endpoints exercised below. Node 20+
// provides global `fetch`/`Response`, so no polyfill is required.
const mockFetch = vi.fn(async (url: any, init?: any) => {
  const urlString = typeof url === 'string' ? url : url.toString();
  let body: any = {};
  if (init?.body) {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = {};
    }
  }

  if (urlString.endsWith('/api/auth/v1/token')) {
    // Initial sign-in with credentials.
    if (body.email === 'user@example.com' && body.password === 'password') {
      return new Response(
        JSON.stringify({
          accessToken: 'ACCESS_TOKEN_123',
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshToken: 'REFRESH_TOKEN_456',
        }),
        { status: 200 }
      );
    }
    // Refresh exchange.
    if (
      body.grantType === 'refresh_token' &&
      body.refreshToken === 'REFRESH_TOKEN_456'
    ) {
      return new Response(
        JSON.stringify({
          accessToken: 'NEW_ACCESS_TOKEN',
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshToken: 'NEW_REFRESH_TOKEN',
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ message: 'Invalid credentials' }), {
      status: 401,
    });
  }

  if (urlString.endsWith('/api/auth/v1/signout')) {
    return new Response(
      JSON.stringify({ success: true, message: 'Signed out' }),
      { status: 200 }
    );
  }

  if (urlString.endsWith('/api/projectRuntimeSettings')) {
    return new Response(JSON.stringify({ passwordAuth: { enabled: true } }), {
      status: 200,
    });
  }

  return new Response(JSON.stringify({ message: 'Not Found' }), {
    status: 404,
  });
});

global.fetch = mockFetch as unknown as typeof fetch;

function createAuth(): Auth {
  return new Auth(
    new ApiClient({
      baseUrl: 'https://example.com',
      publishableKey: 'pk-test',
    })
  );
}

describe('Auth in bare Node environment (no DOM globals)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs with the browser DOM surface absent (environment sanity check)', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof localStorage).toBe('undefined');
    // Node 21+ exposes a partial global `navigator`, but it has no Web Locks
    // API — the same shape edge/worker runtimes present. The refresh guard
    // must treat `navigator.locks` being undefined as "use the local lock".
    expect((globalThis.navigator as any)?.locks).toBeUndefined();
  });

  it('constructs without throwing and defaults to a null (no-op) storage', () => {
    const auth = createAuth();
    const session = auth.getSession();
    expect(session.isAuthenticated).toBe(false);
    // Synchronous reads must not throw when storage/DOM are unavailable.
    expect(() => auth.hasRefreshToken()).not.toThrow();
    auth.destroy();
  });

  it('destroys cleanly when no window/document listeners were ever attached', () => {
    const auth = createAuth();
    expect(() => auth.destroy()).not.toThrow();
  });

  it('signs in, refreshes, and signs out with no DOM present', async () => {
    const auth = createAuth();

    await auth.signIn({ email: 'user@example.com', password: 'password' });
    expect(auth.getSession().isAuthenticated).toBe(true);
    expect(auth.hasRefreshToken()).toBe(true);

    const tokens = await auth.refreshSession();
    expect(tokens.accessToken).toBeDefined();

    await auth.signOut();
    expect(auth.getSession().isAuthenticated).toBe(false);
    auth.destroy();
  });

  it('refreshSession falls back to the local lock when navigator.locks is absent', async () => {
    // The jsdom suite covers the same guard with a mock-injected navigator.
    // Here it runs against the real Node global surface (navigator absent or
    // without Web Locks), so refreshSession must resolve via the local lock.
    expect((globalThis.navigator as any)?.locks).toBeUndefined();

    const auth = createAuth();
    await auth.signIn({ email: 'user@example.com', password: 'password' });

    await expect(auth.refreshSession()).resolves.toBeDefined();
    auth.destroy();
  });
});
