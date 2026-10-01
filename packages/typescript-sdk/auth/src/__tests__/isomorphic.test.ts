import { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { Auth } from '..';
import type { AuthStorage } from '../Auth';

// Minimal mock fetch that handles essential auth endpoints
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

  if (urlString.endsWith('/api/auth/v1/passwordless/send')) {
    return new Response(
      JSON.stringify({ success: true, message: 'Magic link sent' }),
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

global.fetch = mockFetch;

function createApiClient(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://example.com',
    publishableKey: 'pk-test',
  });
}

/**
 * Creates a mock async AuthStorage backed by a plain object.
 */
function createAsyncStorage(): {
  storage: AuthStorage;
  data: Record<string, string>;
} {
  const data: Record<string, string> = {};
  const storage: AuthStorage = {
    getItem: async (key: string) => data[key] ?? null,
    setItem: async (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: async (key: string) => {
      delete data[key];
    },
    clear: async () => {
      for (const key in data) {
        delete data[key];
      }
    },
    keys: async (prefix: string) =>
      Object.keys(data).filter((k) => k.startsWith(prefix)),
  };
  return { storage, data };
}

describe('Isomorphic Auth', () => {
  let apiClient: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient = createApiClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Node.js environment (no window)', () => {
    let savedWindow: any;

    beforeEach(() => {
      savedWindow = globalThis.window;
      // @ts-expect-error -- simulate Node.js with no window
      delete globalThis.window;
    });

    afterEach(() => {
      globalThis.window = savedWindow;
    });

    it('constructs without crashing when window is undefined', () => {
      const auth = new Auth(apiClient);
      expect(auth).toBeDefined();
      auth.destroy();
    });

    it('storage is null when window is undefined', async () => {
      const auth = new Auth(apiClient);
      const session = auth.getSession();
      expect(session.isAuthenticated).toBe(false);
      auth.destroy();
    });

    it('signIn and signOut work with null storage', async () => {
      const auth = new Auth(apiClient);
      await auth.signIn({ email: 'user@example.com', password: 'password' });
      const session = auth.getSession();
      expect(session.isAuthenticated).toBe(true);

      await auth.signOut();
      const after = auth.getSession();
      expect(after.isAuthenticated).toBe(false);
      auth.destroy();
    });
  });

  describe('async AuthStorage', () => {
    it('persists session to async storage on signIn', async () => {
      const { storage, data } = createAsyncStorage();
      const auth = new Auth(apiClient, { storage });

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Wait a tick for the fire-and-forget onSessionChange listener to flush
      await new Promise((r) => setTimeout(r, 50));

      const keys = Object.keys(data);
      expect(keys.length).toBeGreaterThan(0);
      auth.destroy();
    });

    it('restores session from async storage on re-instantiation', async () => {
      const { storage } = createAsyncStorage();
      const auth1 = new Auth(apiClient, { storage });

      await auth1.signIn({ email: 'user@example.com', password: 'password' });
      await new Promise((r) => setTimeout(r, 50));

      auth1.destroy();

      // Create new auth instance with same storage — eager init restores the session
      const auth2 = new Auth(apiClient, { storage });
      // Wait for eager initialization to complete (async storage read)
      await new Promise((r) => setTimeout(r, 50));
      const session = auth2.getSession();
      // Session should be restored from storage
      expect(session.isAuthenticated).toBe(true);
      auth2.destroy();
    });

    it('notifies onSessionChange subscribers after async restore completes', async () => {
      const { storage } = createAsyncStorage();
      const auth1 = new Auth(apiClient, { storage });
      await auth1.signIn({ email: 'user@example.com', password: 'password' });
      await new Promise((r) => setTimeout(r, 50));
      auth1.destroy();

      // New instance with the same async storage — subscribe before restore runs.
      const auth2 = new Auth(apiClient, { storage });
      const callbacks: boolean[] = [];
      auth2.onSessionChange((session) =>
        callbacks.push(!!session?.isAuthenticated)
      );

      // Initial on-subscribe callback fires with no session yet.
      expect(callbacks).toEqual([false]);

      // Subscriber must be notified once async restore lands.
      await new Promise((r) => setTimeout(r, 50));
      expect(callbacks).toContain(true);
      auth2.destroy();
    });

    it('clears async storage on signOut', async () => {
      const { storage, data } = createAsyncStorage();
      const auth = new Auth(apiClient, { storage });

      await auth.signIn({ email: 'user@example.com', password: 'password' });
      await new Promise((r) => setTimeout(r, 50));
      expect(Object.keys(data).length).toBeGreaterThan(0);

      await auth.signOut();
      // Session key should be removed
      const sessionKeys = Object.keys(data).filter(
        (k) => !k.startsWith('rayfin_pkce_')
      );
      expect(sessionKeys.length).toBe(0);
      auth.destroy();
    });
  });

  describe('PKCE in-memory fallback', () => {
    it('sendMagicLink works with storage: false (in-memory PKCE)', async () => {
      const auth = new Auth(apiClient, { storage: false });
      const result = await auth.sendMagicLink({
        email: 'user@example.com',
        redirectUri: 'https://myapp.com/callback',
      });

      expect(result.success).toBe(true);
      expect(result.state).toBeDefined();
      auth.destroy();
    });

    it('PKCE state is stored in custom storage when provided', async () => {
      const { storage, data } = createAsyncStorage();
      const auth = new Auth(apiClient, { storage });

      const result = await auth.sendMagicLink({
        email: 'user@example.com',
        redirectUri: 'https://myapp.com/callback',
      });

      const pkceKey = `rayfin_pkce_${result.state}`;
      expect(data[pkceKey]).toBeDefined();
      auth.destroy();
    });
  });

  describe('persistSession: false', () => {
    it('does not write to storage on signIn', async () => {
      const { storage } = createAsyncStorage();
      const spy = vi.spyOn(storage, 'setItem');
      const auth = new Auth(apiClient, {
        storage,
        persistSession: false,
      });

      await auth.signIn({ email: 'user@example.com', password: 'password' });
      await new Promise((r) => setTimeout(r, 50));

      // setItem should not have been called for session persistence
      expect(spy).not.toHaveBeenCalled();
      auth.destroy();
    });

    it('still maintains in-memory session', async () => {
      const auth = new Auth(apiClient, { persistSession: false });

      await auth.signIn({ email: 'user@example.com', password: 'password' });
      const session = auth.getSession();
      expect(session.isAuthenticated).toBe(true);
      auth.destroy();
    });
  });

  describe('autoRefreshToken: false', () => {
    it('does not schedule session expiration timer', async () => {
      vi.useFakeTimers();
      const auth = new Auth(apiClient, {
        storage: false,
        autoRefreshToken: false,
      });

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Advance past token expiration — should NOT trigger auto-refresh
      const expiredEvents: string[] = [];
      auth.on('AUTH_SESSION_EXPIRED', () => expiredEvents.push('expired'));
      auth.on('AUTH_REFRESH', () => expiredEvents.push('refresh'));

      await vi.advanceTimersByTimeAsync(901 * 1000);

      // No auto-refresh or expiration events because autoRefreshToken is false
      expect(expiredEvents).toEqual([]);
      auth.destroy();
      vi.useRealTimers();
    });
  });

  describe('multiTabSync: false', () => {
    it('does not register storage event listener', () => {
      const addEventSpy = vi.fn();
      Object.defineProperty(globalThis, 'window', {
        value: {
          localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          },
          addEventListener: addEventSpy,
          removeEventListener: vi.fn(),
        },
        writable: true,
        configurable: true,
      });

      const auth = new Auth(apiClient, { multiTabSync: false });

      // addEventListener should NOT have been called for 'storage'
      const storageCalls = addEventSpy.mock.calls.filter(
        (call: any[]) => call[0] === 'storage'
      );
      expect(storageCalls.length).toBe(0);
      auth.destroy();
    });
  });

  describe('startAutoRefresh / stopAutoRefresh', () => {
    it('startAutoRefresh is a no-op when autoRefreshToken is true', async () => {
      const auth = new Auth(apiClient, {
        storage: false,
        autoRefreshToken: true,
      });

      // Should not throw
      await auth.startAutoRefresh();
      auth.destroy();
    });

    it('stopAutoRefresh is a no-op when autoRefreshToken is true', async () => {
      const auth = new Auth(apiClient, {
        storage: false,
        autoRefreshToken: true,
      });

      // Should not throw
      await auth.stopAutoRefresh();
      auth.destroy();
    });

    it('stopAutoRefresh cancels pending timers', async () => {
      vi.useFakeTimers();
      const auth = new Auth(apiClient, {
        storage: false,
        autoRefreshToken: false,
      });

      await auth.signIn({ email: 'user@example.com', password: 'password' });
      await auth.startAutoRefresh();

      // Timer is now running — stop it
      await auth.stopAutoRefresh();

      // Advance time — no events should fire
      const events: string[] = [];
      auth.on('AUTH_SESSION_EXPIRED', () => events.push('expired'));
      auth.on('AUTH_REFRESH', () => events.push('refresh'));
      await vi.advanceTimersByTimeAsync(901 * 1000);

      expect(events).toEqual([]);
      auth.destroy();
      vi.useRealTimers();
    });

    it('startAutoRefresh schedules an expiration timer that refreshes on expiry', async () => {
      vi.useFakeTimers();
      const auth = new Auth(apiClient, {
        storage: false,
        autoRefreshToken: false,
      });

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const events: string[] = [];
      auth.on('AUTH_REFRESH', () => events.push('refresh'));
      auth.on('AUTH_SESSION_EXPIRED', () => events.push('expired'));

      // Enable manual scheduling — this must arm the expiration timer.
      await auth.startAutoRefresh();

      // Advance past expiry — the timer should fire and refresh the session.
      await vi.advanceTimersByTimeAsync(901 * 1000);

      expect(events).toContain('refresh');
      expect(auth.getSession().isAuthenticated).toBe(true);
      auth.destroy();
      vi.useRealTimers();
    });

    it('does not schedule a timer in manual mode until startAutoRefresh is called', async () => {
      vi.useFakeTimers();
      const auth = new Auth(apiClient, {
        storage: false,
        autoRefreshToken: false,
      });

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const events: string[] = [];
      auth.on('AUTH_REFRESH', () => events.push('refresh'));
      auth.on('AUTH_SESSION_EXPIRED', () => events.push('expired'));

      // No startAutoRefresh() — signIn alone must not arm a timer in manual mode.
      await vi.advanceTimersByTimeAsync(901 * 1000);

      expect(events).toEqual([]);
      auth.destroy();
      vi.useRealTimers();
    });
  });
});
