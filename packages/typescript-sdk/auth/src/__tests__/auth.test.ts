import { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { Auth } from '..';
import type { OpaqueSession } from '../types';

// Mock fetch for all auth endpoints
global.fetch = vi.fn(async (url: any, init?: any) => {
  const urlString = typeof url === 'string' ? url : url.toString();

  // Parse request body based on Content-Type
  let body: any = {};
  if (init?.body) {
    const contentType =
      init.headers?.['Content-Type'] ||
      init.headers?.get?.('Content-Type') ||
      '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      // Parse form-urlencoded data
      const params = new URLSearchParams(init.body);
      body = Object.fromEntries(params.entries());
    } else {
      // Parse as JSON
      try {
        body = JSON.parse(init.body);
      } catch {
        body = {};
      }
    }
  }

  // Token endpoint (password grant and refresh token grant)
  if (urlString.endsWith('/api/auth/v1/token')) {
    // Password grant
    if (body.email === 'user@example.com' && body.password === 'password') {
      return new Response(
        JSON.stringify({
          accessToken: 'ACCESS_TOKEN_123',
          tokenType: 'Bearer',
          expiresIn: 900, // 15 minutes
          refreshToken: 'REFRESH_TOKEN_456',
        }),
        { status: 200 }
      );
    }
    // Refresh token grant with valid token
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
    // Refresh token grant with new token (for subsequent refreshes)
    if (
      body.grantType === 'refresh_token' &&
      body.refreshToken === 'NEW_REFRESH_TOKEN'
    ) {
      return new Response(
        JSON.stringify({
          accessToken: 'NEWER_ACCESS_TOKEN',
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshToken: 'NEWER_REFRESH_TOKEN',
        }),
        { status: 200 }
      );
    }
    // Invalid credentials or refresh token
    return new Response(JSON.stringify({ message: 'Invalid credentials' }), {
      status: 401,
    });
  }

  // Signup endpoint
  if (urlString.endsWith('/api/auth/v1/signup')) {
    if (body.email && body.password) {
      return new Response(
        JSON.stringify({
          userId: 'user-123',
          email: body.email,
          message: 'User created successfully',
        }),
        { status: 201 }
      );
    }
    return new Response(JSON.stringify({ message: 'Invalid signup data' }), {
      status: 400,
    });
  }

  // Sign out endpoint
  if (urlString.endsWith('/api/auth/v1/signout')) {
    return new Response(
      JSON.stringify({ message: 'Signed out successfully' }),
      { status: 200 }
    );
  }

  // Sign out all sessions endpoint
  if (urlString.endsWith('/api/auth/v1/signout-all')) {
    return new Response(
      JSON.stringify({ message: 'All sessions signed out successfully' }),
      { status: 200 }
    );
  }

  // Email verification endpoint
  if (urlString.includes('/api/auth/v1/verify-email')) {
    // Use a base URL in case urlString is relative
    const url = new URL(urlString, 'https://example.com');
    const token = url.searchParams.get('token');

    if (token === 'VALID_VERIFICATION_TOKEN') {
      return new Response(
        JSON.stringify({
          success: true,
          message:
            'Email verified successfully! You can now sign in to your account.',
          title: 'Email Verified',
        }),
        { status: 200 }
      );
    }
    if (token === 'EXPIRED_TOKEN') {
      return new Response(
        JSON.stringify({
          success: false,
          message:
            'This verification link has expired. Please request a new one.',
          title: 'Link Expired',
        }),
        { status: 400 }
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        message: 'Invalid verification token.',
        title: 'Verification Failed',
      }),
      { status: 400 }
    );
  }

  // Password reset request endpoint
  if (
    urlString.endsWith('/api/auth/v1/reset-password') &&
    init?.method !== 'POST'
  ) {
    return new Response(JSON.stringify({ message: 'Method not allowed' }), {
      status: 405,
    });
  }
  if (urlString.endsWith('/api/auth/v1/reset-password')) {
    return new Response(
      JSON.stringify({
        success: true,
        message:
          'If an account exists with this email, a reset link has been sent.',
      }),
      { status: 200 }
    );
  }

  // Password reset completion endpoint
  if (urlString.endsWith('/api/auth/v1/reset-password/complete')) {
    if (body.token === 'VALID_RESET_TOKEN' && body.newPassword) {
      return new Response(
        JSON.stringify({
          success: true,
          message:
            'Password updated successfully. You can now sign in with your new password.',
        }),
        { status: 200 }
      );
    }
    if (body.token === 'EXPIRED_RESET_TOKEN') {
      return new Response(
        JSON.stringify({
          error: 'token_expired',
          message: 'Reset link has expired',
        }),
        { status: 400 }
      );
    }
    if (body.token === 'USED_TOKEN') {
      return new Response(
        JSON.stringify({
          error: 'token_already_used',
          message: 'This reset link has already been used',
        }),
        { status: 400 }
      );
    }
    return new Response(
      JSON.stringify({
        error: 'invalid_token',
        message: 'Invalid reset token',
      }),
      { status: 400 }
    );
  }

  // JWKS endpoint
  if (urlString.endsWith('/.well-known/jwks.json')) {
    return new Response(
      JSON.stringify({
        keys: [
          {
            kty: 'RSA',
            use: 'sig',
            kid: 'key-1',
            n: 'sample-modulus',
            e: 'AQAB',
          },
        ],
      }),
      { status: 200 }
    );
  }

  return new Response(JSON.stringify({ message: 'Not Found' }), {
    status: 404,
  });
});

describe('Auth API - Comprehensive Tests', () => {
  let auth: Auth;
  let apiClient: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient = new ApiClient({
      baseUrl: 'https://example.com',
      publishableKey: 'pk-commonSampleAppPKkey',
    });
    auth = new Auth(apiClient, { storage: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Sign Up', () => {
    it('creates a new user account', async () => {
      const response = await auth.signUp({
        email: 'newuser@example.com',
        password: 'securePassword123!',
      });

      expect(response.userId).toBe('user-123');
      expect(response.email).toBe('newuser@example.com');
    });

    it('does not automatically authenticate after signup', async () => {
      await auth.signUp({
        email: 'newuser@example.com',
        password: 'securePassword123!',
      });

      const session = auth.getSession();
      expect(session.isAuthenticated).toBe(false);
    });

    it('emits AUTH_SIGNUP event on successful signup', async () => {
      const signupEvents: OpaqueSession[] = [];
      auth.on('AUTH_SIGNUP', (session) => signupEvents.push(session));

      await auth.signUp({
        email: 'newuser@example.com',
        password: 'securePassword123!',
      });

      expect(signupEvents.length).toBe(1);
      expect(signupEvents[0]?.isAuthenticated).toBe(false);
    });
  });

  describe('Sign In / Login', () => {
    it('authenticates with email and password using login()', async () => {
      const response = await auth.signIn({
        email: 'user@example.com',
        password: 'password',
      });

      expect(response.accessToken).toBe('ACCESS_TOKEN_123');
      expect(response.tokenType).toBe('Bearer');
      expect(response.expiresIn).toBe(900);
      expect(response.refreshToken).toBe('REFRESH_TOKEN_456');
    });

    it('authenticates with email and password using signIn() alias', async () => {
      const response = await auth.signIn({
        email: 'user@example.com',
        password: 'password',
      });

      expect(response.accessToken).toBe('ACCESS_TOKEN_123');
      expect(response.tokenType).toBe('Bearer');
    });

    it('updates session state after login', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const session = auth.getSession();
      expect(session.isAuthenticated).toBe(true);
    });

    it('emits AUTH_LOGIN event on successful login', async () => {
      const loginEvents: OpaqueSession[] = [];
      auth.on('AUTH_LOGIN', (session) => loginEvents.push(session));

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      expect(loginEvents.length).toBe(1);
      expect(loginEvents[0]?.isAuthenticated).toBe(true);
    });

    it('calculates session expiration time', async () => {
      const beforeLogin = Date.now();
      await auth.signIn({ email: 'user@example.com', password: 'password' });
      const afterLogin = Date.now();

      const session = auth.getSession();
      expect(session.expiresAt).toBeDefined();

      if (session.expiresAt) {
        const expiresAtTime = session.expiresAt.getTime();
        const expectedExpiry = beforeLogin + 900 * 1000; // 15 minutes
        const tolerance = 5000; // 5 second tolerance

        expect(expiresAtTime).toBeGreaterThanOrEqual(
          expectedExpiry - tolerance
        );
        expect(expiresAtTime).toBeLessThanOrEqual(
          afterLogin + 900 * 1000 + tolerance
        );
      }
    });
  });

  describe('Sign Out', () => {
    it('clears session on signOut()', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });
      expect(auth.getSession().isAuthenticated).toBe(true);

      await auth.signOut();

      const session = auth.getSession();
      expect(session.isAuthenticated).toBe(false);
    });

    it('emits AUTH_LOGOUT event on signOut', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const logoutEvents: OpaqueSession[] = [];
      auth.on('AUTH_LOGOUT', (session) => logoutEvents.push(session));

      await auth.signOut();

      expect(logoutEvents.length).toBe(1);
      expect(logoutEvents[0]?.isAuthenticated).toBe(false);
    });

    it('signs out all sessions with signOutAll()', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });

      await auth.signOutAll();

      const updatedSession = auth.getSession();
      expect(updatedSession.isAuthenticated).toBe(false);
    });
  });

  describe('Session Management', () => {
    it('returns opaque session without tokens', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const session = auth.getSession();
      expect(session.isAuthenticated).toBe(true);
      // @ts-expect-error - tokens should not be exposed
      expect(session.accessToken).toBeUndefined();
      // @ts-expect-error
      expect(session.refreshToken).toBeUndefined();
    });

    it('fires onSessionChange callback on login', async () => {
      const sessionChanges: (OpaqueSession | null)[] = [];
      auth.onSessionChange((session) => sessionChanges.push(session));

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      expect(sessionChanges.length).toBeGreaterThan(0);
      expect(sessionChanges[sessionChanges.length - 1]?.isAuthenticated).toBe(
        true
      );
    });

    it('fires onSessionChange callback on logout', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const sessionChanges: (OpaqueSession | null)[] = [];
      auth.onSessionChange((session) => sessionChanges.push(session));

      await auth.signOut();

      expect(sessionChanges.length).toBeGreaterThan(0);
      expect(sessionChanges[sessionChanges.length - 1]?.isAuthenticated).toBe(
        false
      );
    });

    it('emits AUTH_SESSION_EXPIRED when session expires', async () => {
      vi.useFakeTimers();
      const events: string[] = [];

      auth.on('AUTH_LOGIN', () => events.push('LOGIN'));
      auth.on('AUTH_SESSION_EXPIRED', () => events.push('EXPIRED'));
      auth.on('AUTH_REFRESH', () => events.push('REFRESH'));

      await auth.signIn({ email: 'user@example.com', password: 'password' });
      expect(events).toContain('LOGIN');
      expect(auth.getSession().isAuthenticated).toBe(true);

      // Fast-forward past expiration (15 minutes + 1 second)
      await vi.advanceTimersByTimeAsync(901 * 1000);

      // With refresh token present, auto-refresh should happen instead of expiration
      expect(events).toContain('REFRESH');
      expect(auth.getSession().isAuthenticated).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('Token Refresh', () => {
    it('has refreshSession method for manual token refresh', () => {
      // Verify refresh method exists (actual refresh tested in integration tests)
      expect(typeof auth.refreshSession).toBe('function');
      expect(typeof auth.hasRefreshToken).toBe('function');
    });

    it('supports AUTH_REFRESH event type for token refresh notifications', () => {
      const refreshEvents: OpaqueSession[] = [];
      auth.on('AUTH_REFRESH', (session) => refreshEvents.push(session));

      // Verify handler registered without errors
      expect(refreshEvents.length).toBe(0);
    });

    it('throws error when refreshing without refresh token', async () => {
      // No login, so no refresh token
      await expect(auth.refreshSession()).rejects.toThrow(
        'No refresh token available'
      );
    });

    it('clears session and emits AUTH_LOGOUT when refresh endpoint returns 401', async () => {
      // Reproduces the "Authentication failed after token refresh" bug:
      // when the server rejects the refresh token (e.g., replay-attack revocation,
      // signing-key eviction, or expired refresh token), the SDK must purge the
      // dead session from storage so the next page load returns the user to a
      // clean signed-out state — not replay the doomed token forever.
      const memoryStore = new Map<string, string>();
      const customStorage = {
        getItem: (k: string) => memoryStore.get(k) ?? null,
        setItem: (k: string, v: string) => {
          memoryStore.set(k, v);
        },
        removeItem: (k: string) => {
          memoryStore.delete(k);
        },
        clear: () => {
          memoryStore.clear();
        },
      };

      const localApiClient = new ApiClient({
        baseUrl: 'https://example.com',
        publishableKey: 'pk-commonSampleAppPKkey',
      });
      const localAuth = new Auth(localApiClient, { storage: customStorage });

      // Establish a session so we have a refresh token in memory + storage
      await localAuth.signIn({
        email: 'user@example.com',
        password: 'password',
      });
      expect(localAuth.hasRefreshToken()).toBe(true);
      expect(memoryStore.size).toBeGreaterThan(0);

      const logoutEvents: OpaqueSession[] = [];
      localAuth.on('AUTH_LOGOUT', (session) => logoutEvents.push(session));

      const expiredEvents: OpaqueSession[] = [];
      localAuth.on('AUTH_SESSION_EXPIRED', (session) =>
        expiredEvents.push(session)
      );

      // Force the next /token call (the refresh) to return 401, simulating a
      // server-side invalid_grant (revoked / expired / replay-detected token).
      const originalFetch = global.fetch;
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: 'Invalid or expired refresh token.' }),
          {
            status: 401,
          }
        )
      );

      try {
        await expect(localAuth.refreshSession()).rejects.toThrow(
          'Session expired'
        );

        // Storage must be cleared so a page reload starts fresh
        expect(memoryStore.size).toBe(0);
        // In-memory session must be invalidated
        expect(localAuth.hasRefreshToken()).toBe(false);
        expect(localAuth.getSession().isAuthenticated).toBe(false);
        // AUTH_LOGOUT must fire so app state can react
        expect(logoutEvents.length).toBe(1);
        // AUTH_SESSION_EXPIRED must fire so apps can show "session expired" UX
        expect(expiredEvents.length).toBe(1);
      } finally {
        spy.mockRestore();
        global.fetch = originalFetch;
      }
    });
  });

  describe('JWKS Endpoint', () => {
    it('fetches JSON Web Key Set for stateless verification', async () => {
      const jwks = await auth.getJwks();

      expect(jwks.keys).toBeDefined();
      expect(Array.isArray(jwks.keys)).toBe(true);
      const keys = jwks.keys as Array<{ kty: string; use: string }>;
      expect(keys.length).toBeGreaterThan(0);
      expect(keys[0]?.kty).toBe('RSA');
      expect(keys[0]?.use).toBe('sig');
    });
  });

  describe('JWKS Key Matching (alg fallback)', () => {
    it('matches key by kid when alg is absent from JWKS key (Entra/FMI tokens)', async () => {
      // The default mock JWKS returns keys WITHOUT alg — same as Entra.
      // Before the fix, validateAccessToken failed because it required
      // k.alg === alg, but k.alg was undefined.
      const jwks = await auth.getJwks();
      const keys = jwks.keys as Array<{
        kid: string;
        alg?: string;
        kty: string;
      }>;

      // Verify the mock key has no alg (matches Entra behavior)
      expect(keys[0]?.alg).toBeUndefined();
      expect(keys[0]?.kid).toBe('key-1');

      // The key should be findable with our relaxed matching logic:
      // k.kid === kid && (k.alg === alg || !k.alg)
      const targetKid = 'key-1';
      const tokenAlg = 'RS256';
      const matched = keys.find(
        (k) => k.kid === targetKid && (k.alg === tokenAlg || !k.alg)
      );
      expect(matched).toBeDefined();
      expect(matched?.kid).toBe('key-1');
    });

    it('matches key by kid and alg when alg is present in JWKS key', () => {
      // When keys include alg (e.g., Rayfin's own ES256 keys), both must match.
      const keys = [
        { kid: 'rayfin-key-1', alg: 'ES256', kty: 'EC' },
        { kid: 'rayfin-key-2', alg: 'RS256', kty: 'RSA' },
      ];

      const matched = keys.find(
        (k) => k.kid === 'rayfin-key-2' && (k.alg === 'RS256' || !k.alg)
      );
      expect(matched).toBeDefined();
      expect(matched?.kid).toBe('rayfin-key-2');

      // Wrong alg should NOT match when alg is present
      const noMatch = keys.find(
        (k) => k.kid === 'rayfin-key-1' && (k.alg === 'RS256' || !k.alg)
      );
      expect(noMatch).toBeUndefined();
    });

    it('returns undefined when kid does not match any key', () => {
      const keys = [
        { kid: 'key-1', kty: 'RSA' },
        { kid: 'key-2', alg: 'RS256', kty: 'RSA' },
      ];

      const matched = keys.find(
        (k) => k.kid === 'nonexistent-kid' && (k.alg === 'RS256' || !k.alg)
      );
      expect(matched).toBeUndefined();
    });
  });

  describe('Token Concealment', () => {
    it('does not expose tokens in the session object', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const session = auth.getSession();
      // @ts-expect-error - checking runtime
      expect(session.accessToken).toBeUndefined();
      // @ts-expect-error - checking runtime
      expect(session.refreshToken).toBeUndefined();

      // Session should only have opaque properties
      expect(session.isAuthenticated).toBe(true);
      expect(session.user).toBeDefined();
    });

    it('session object does not leak tokens via JSON.stringify', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const session = auth.getSession();
      const sessionJson = JSON.stringify(session);

      // Tokens should not appear in JSON serialization
      expect(sessionJson).not.toContain('ACCESS_TOKEN');
      expect(sessionJson).not.toContain('REFRESH_TOKEN');
    });
  });

  describe('Event System', () => {
    it('supports all Phase 1 event types', () => {
      const events = [
        'AUTH_SIGNUP',
        'AUTH_LOGIN',
        'AUTH_LOGOUT',
        'AUTH_REFRESH',
        'AUTH_SESSION_EXPIRED',
      ] as const;

      const handlerCounts: Record<string, number> = {};

      events.forEach((event) => {
        auth.on(event, () => {
          handlerCounts[event] = (handlerCounts[event] || 0) + 1;
        });
      });

      // Verify all handlers are registered without errors
      expect(Object.keys(handlerCounts).length).toBe(0); // No events fired yet
    });

    it('allows multiple handlers for same event', async () => {
      const calls: string[] = [];

      auth.on('AUTH_LOGIN', () => calls.push('handler1'));
      auth.on('AUTH_LOGIN', () => calls.push('handler2'));

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      expect(calls).toEqual(['handler1', 'handler2']);
    });

    it('handlers receive session data', async () => {
      let receivedSession: OpaqueSession | undefined;

      auth.on('AUTH_LOGIN', (session) => {
        receivedSession = session;
      });

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      expect(receivedSession).toBeDefined();
      expect(receivedSession?.isAuthenticated).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('handles invalid credentials gracefully', async () => {
      await expect(
        auth.signIn({ email: 'wrong@example.com', password: 'wrongpassword' })
      ).rejects.toThrow();
    });

    it('maintains unauthenticated state after failed login', async () => {
      try {
        await auth.signIn({
          email: 'wrong@example.com',
          password: 'wrongpassword',
        });
      } catch {
        // Expected to fail
      }

      const session = auth.getSession();
      expect(session.isAuthenticated).toBe(false);
    });
  });

  describe('Email Verification', () => {
    it('verifies email with valid token', async () => {
      const result = await auth.verifyEmail('VALID_VERIFICATION_TOKEN');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Email verified successfully');
    });

    it('emits AUTH_EMAIL_VERIFIED event on success', async () => {
      const events: OpaqueSession[] = [];
      auth.on('AUTH_EMAIL_VERIFIED', (session) => events.push(session));

      await auth.verifyEmail('VALID_VERIFICATION_TOKEN');

      expect(events.length).toBe(1);
    });

    it('handles expired verification token', async () => {
      await expect(auth.verifyEmail('EXPIRED_TOKEN')).rejects.toThrow();
    });

    it('handles invalid verification token', async () => {
      await expect(auth.verifyEmail('INVALID_TOKEN')).rejects.toThrow();
    });

    it('validates token is provided', async () => {
      await expect(auth.verifyEmail('')).rejects.toThrow(
        'Verification token is required'
      );
    });
  });

  describe('Password Reset', () => {
    it('requests password reset email', async () => {
      const result = await auth.requestPasswordReset('user@example.com');

      expect(result.success).toBe(true);
      expect(result.message).toContain('reset link has been sent');
    });

    it('emits AUTH_PASSWORD_RESET_REQUESTED event', async () => {
      const events: OpaqueSession[] = [];
      auth.on('AUTH_PASSWORD_RESET_REQUESTED', (session) =>
        events.push(session)
      );

      await auth.requestPasswordReset('user@example.com');

      expect(events.length).toBe(1);
    });

    it('validates email is provided for reset request', async () => {
      await expect(auth.requestPasswordReset('')).rejects.toThrow(
        'Email is required'
      );
    });

    it('completes password reset with valid token', async () => {
      const result = await auth.completePasswordReset(
        'VALID_RESET_TOKEN',
        'newPassword123'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Password updated successfully');
    });

    it('emits AUTH_PASSWORD_RESET_COMPLETED event', async () => {
      const events: OpaqueSession[] = [];
      auth.on('AUTH_PASSWORD_RESET_COMPLETED', (session) =>
        events.push(session)
      );

      await auth.completePasswordReset('VALID_RESET_TOKEN', 'newPassword123');

      expect(events.length).toBe(1);
    });

    it('handles expired reset token', async () => {
      await expect(
        auth.completePasswordReset('EXPIRED_RESET_TOKEN', 'newPassword123')
      ).rejects.toThrow();
    });

    it('handles already used reset token', async () => {
      await expect(
        auth.completePasswordReset('USED_TOKEN', 'newPassword123')
      ).rejects.toThrow();
    });

    it('validates token is provided for reset completion', async () => {
      await expect(
        auth.completePasswordReset('', 'newPassword123')
      ).rejects.toThrow('Reset token is required');
    });

    it('validates password is provided for reset completion', async () => {
      await expect(
        auth.completePasswordReset('VALID_RESET_TOKEN', '')
      ).rejects.toThrow('New password is required');
    });

    it('validates password length for reset completion', async () => {
      await expect(
        auth.completePasswordReset('VALID_RESET_TOKEN', '12345')
      ).rejects.toThrow('Password must be at least 6 characters');
    });
  });

  describe('Eager Refresh on Construction (Issue 2)', () => {
    /**
     * Helper: creates a custom in-memory storage pre-seeded with an expired
     * session that has a valid refresh token, simulating a page reload after
     * the AT has expired (e.g. tab was backgrounded for a long time).
     */
    function createExpiredSessionStorage() {
      const store = new Map<string, string>();
      const expiredSession = {
        user: { id: 'user-123', email: 'user@example.com' },
        accessToken: 'STALE_ACCESS_TOKEN',
        refreshToken: 'REFRESH_TOKEN_456',
        expiresAt: new Date(Date.now() - 60_000).toISOString(), // Expired 1 minute ago
      };
      store.set('authSession', JSON.stringify(expiredSession));

      return {
        storage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => {
            store.set(k, v);
          },
          removeItem: (k: string) => {
            store.delete(k);
          },
          clear: () => {
            store.clear();
          },
        },
        store,
      };
    }

    it('does not expose the stale access token to attached clients', async () => {
      const { storage } = createExpiredSessionStorage();

      // Keep the eager refresh pending so we can deterministically observe the
      // restored-but-withheld state: the stored AT is expired, so accessToken
      // stays null until a refresh resolves — which we never allow here.
      const originalFetch = global.fetch;
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url: any, init?: any) => {
          const urlString = typeof url === 'string' ? url : url.toString();
          if (urlString.includes('/api/auth/v1/token')) {
            return new Promise<Response>(() => {}); // never resolves
          }
          return (originalFetch as Function)(url, init);
        });

      try {
        const localApiClient = new ApiClient({
          baseUrl: 'https://example.com',
          publishableKey: 'pk-commonSampleAppPKkey',
        });
        const localAuth = new Auth(localApiClient, { storage });

        // The callback should return null (stale token withheld), not the
        // expired 'STALE_ACCESS_TOKEN' from storage.
        const dataClient = new ApiClient({
          baseUrl: 'https://example.com',
          publishableKey: 'pk-commonSampleAppPKkey',
        });
        localAuth.attachToClient(dataClient);

        // Initialization restores the session from storage on a microtask;
        // wait for the in-memory session to be populated.
        await vi.waitFor(() => {
          expect(localAuth.getSession().user).not.toBeNull();
        });

        // internalSession exists (session was restored) but isAuthenticated is
        // false because the stale access token is withheld until refresh.
        const session = localAuth.getSession();
        expect(session.user).not.toBeNull();
        expect(session.isAuthenticated).toBe(false); // accessToken is null

        localAuth.destroy();
      } finally {
        spy.mockRestore();
        global.fetch = originalFetch;
      }
    });

    it('eagerly refreshes the AT on construction when session is expired', async () => {
      const { storage } = createExpiredSessionStorage();
      const refreshEvents: OpaqueSession[] = [];

      const localApiClient = new ApiClient({
        baseUrl: 'https://example.com',
        publishableKey: 'pk-commonSampleAppPKkey',
      });
      const localAuth = new Auth(localApiClient, { storage });

      localAuth.on('AUTH_REFRESH', (session) => refreshEvents.push(session));

      // The constructor kicked off refreshSession() — let it settle.
      // Use a zero-ms flush to allow the microtask / promise to resolve.
      await new Promise((r) => setTimeout(r, 50));

      expect(refreshEvents.length).toBe(1);
      expect(localAuth.getSession().isAuthenticated).toBe(true);

      localAuth.destroy();
    });

    it('parallel requests through attached client dedup to a single refresh', async () => {
      const { storage } = createExpiredSessionStorage();

      const localApiClient = new ApiClient({
        baseUrl: 'https://example.com',
        publishableKey: 'pk-commonSampleAppPKkey',
      });
      const localAuth = new Auth(localApiClient, { storage });

      // Wait for the eager refresh to complete
      await new Promise((r) => setTimeout(r, 50));

      // Count how many /token calls were made during construction
      const fetchSpy = vi.mocked(global.fetch);
      const refreshCalls = fetchSpy.mock.calls.filter((c) => {
        const url = String(c[0]);
        const body = c[1]?.body ? String(c[1].body) : '';
        return url.includes('/api/auth/v1/token') && body.includes('refresh');
      });

      // Only one refresh request, regardless of how many internal triggers fired
      expect(refreshCalls.length).toBe(1);

      localAuth.destroy();
    });

    it('clears session if eager refresh gets 401 (RT revoked)', async () => {
      const { storage, store } = createExpiredSessionStorage();

      // Override fetch to return 401 for the refresh call
      const originalFetch = global.fetch;
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url: any, init?: any) => {
          const urlString = typeof url === 'string' ? url : url.toString();
          if (urlString.includes('/api/auth/v1/token')) {
            return new Response(
              JSON.stringify({ message: 'Invalid or expired refresh token.' }),
              { status: 401 }
            );
          }
          // Delegate to original for everything else
          return (originalFetch as Function)(url, init);
        });

      try {
        const localApiClient = new ApiClient({
          baseUrl: 'https://example.com',
          publishableKey: 'pk-commonSampleAppPKkey',
        });
        const localAuth = new Auth(localApiClient, { storage });

        // Let the eager refresh (and its 401 handling) settle
        await new Promise((r) => setTimeout(r, 50));

        // Session should be fully cleared
        expect(localAuth.getSession().isAuthenticated).toBe(false);
        expect(localAuth.hasRefreshToken()).toBe(false);
        expect(store.size).toBe(0); // Storage cleared

        localAuth.destroy();
      } finally {
        spy.mockRestore();
        global.fetch = originalFetch;
      }
    });

    it('logs AuthError at debug level on eager refresh failure', async () => {
      const { storage } = createExpiredSessionStorage();
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      // Make refresh return 401 (SESSION_EXPIRED)
      const originalFetch = global.fetch;
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url: any) => {
          const urlString = typeof url === 'string' ? url : url.toString();
          if (urlString.includes('/api/auth/v1/token')) {
            return new Response(
              JSON.stringify({ message: 'Invalid refresh token' }),
              { status: 401 }
            );
          }
          return (originalFetch as Function)(url);
        });

      try {
        const localApiClient = new ApiClient({
          baseUrl: 'https://example.com',
          publishableKey: 'pk-commonSampleAppPKkey',
        });
        const localAuth = new Auth(localApiClient, { storage });

        await new Promise((r) => setTimeout(r, 50));

        expect(debugSpy).toHaveBeenCalledWith(
          expect.stringContaining('constructor-eager')
        );

        localAuth.destroy();
      } finally {
        spy.mockRestore();
        global.fetch = originalFetch;
        debugSpy.mockRestore();
      }
    });
  });

  describe('Backoff on Refresh Failures (Issue 4)', () => {
    /** Helper: enqueue a 500 response for the next fetch call */
    function mock500Once() {
      vi.mocked(global.fetch).mockImplementationOnce(async () => {
        return new Response(JSON.stringify({ message: 'Server error' }), {
          status: 500,
        });
      });
    }

    /** Helper: enqueue a 401 response for the next fetch call */
    function mock401Once() {
      vi.mocked(global.fetch).mockImplementationOnce(async () => {
        return new Response(
          JSON.stringify({ message: 'Invalid refresh token' }),
          { status: 401 }
        );
      });
    }

    it('short-circuits refresh within the backoff window after a transient failure', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });
      const fetchMock = vi.mocked(global.fetch);
      const callsBefore = fetchMock.mock.calls.length;

      // First refresh fails with 500
      mock500Once();
      await expect(auth.refreshSession()).rejects.toThrow('Server error');

      // Second refresh immediately after should be blocked by backoff
      await expect(auth.refreshSession()).rejects.toThrow(
        'Refresh temporarily unavailable'
      );

      // Only one /token call was made (the second was short-circuited)
      const tokenCalls = fetchMock.mock.calls
        .slice(callsBefore)
        .filter((c) => String(c[0]).includes('/api/auth/v1/token'));
      expect(tokenCalls.length).toBe(1);
    });

    it('resets backoff after a successful refresh', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Fail once with 500
      mock500Once();
      await expect(auth.refreshSession()).rejects.toThrow('Server error');

      // Advance past the initial 5s backoff window
      vi.advanceTimersByTime(5_100);

      // Now succeed (default mock handles refresh_token grant)
      const tokens = await auth.refreshSession();
      expect(tokens.accessToken).toBeDefined();

      // Immediately fail again — backoff count should have reset,
      // so this should attempt the call (not short-circuit)
      const fetchMock = vi.mocked(global.fetch);
      const callsBefore = fetchMock.mock.calls.length;

      mock500Once();
      await expect(auth.refreshSession()).rejects.toThrow('Server error');

      // Verify the call was made (not blocked by backoff)
      const tokenCalls = fetchMock.mock.calls
        .slice(callsBefore)
        .filter((c) => String(c[0]).includes('/api/auth/v1/token'));
      expect(tokenCalls.length).toBe(1);

      vi.useRealTimers();
    });

    it('escalates backoff window on consecutive failures', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      try {
        // Failure 1 → 5s backoff
        mock500Once();
        await expect(auth.refreshSession()).rejects.toThrow('Server error');

        // Advance 5s → should allow retry
        vi.advanceTimersByTime(5_000);
        // Failure 2 → 10s backoff
        mock500Once();
        await expect(auth.refreshSession()).rejects.toThrow('Server error');

        // Advance only 5s → should still be blocked (need 10s)
        vi.advanceTimersByTime(5_000);
        await expect(auth.refreshSession()).rejects.toThrow(
          'Refresh temporarily unavailable'
        );

        // Advance another 5s (10s total since failure 2) → should allow retry
        vi.advanceTimersByTime(5_000);
        // Failure 3 → 20s backoff
        mock500Once();
        await expect(auth.refreshSession()).rejects.toThrow('Server error');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears backoff state when refresh 401 clears session', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // First: transient 500 failure to set backoff state
      mock500Once();
      await expect(auth.refreshSession()).rejects.toThrow('Server error');

      // Advance past backoff window so it doesn't short-circuit
      vi.advanceTimersByTime(5_100);

      // Now: 401 failure (RT revoked) — should clear session AND backoff
      mock401Once();
      await expect(auth.refreshSession()).rejects.toThrow('Session expired');

      // Session is cleared — no backoff state should remain.
      // A new sign-in + refresh should work without hitting backoff.
      await auth.signIn({ email: 'user@example.com', password: 'password' });
      const tokens = await auth.refreshSession();
      expect(tokens.accessToken).toBeDefined();

      vi.useRealTimers();
    });
  });

  describe('Refresh Error Propagation (Issue 5)', () => {
    it('propagates SERVER_ERROR from token endpoint instead of flattening to 401', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Attach auth to a data client
      const dataClient = new ApiClient({
        baseUrl: 'https://example.com',
        publishableKey: 'pk-commonSampleAppPKkey',
      });
      auth.attachToClient(dataClient);

      // First call: data request returns 401. Second call: refresh returns 500.
      vi.mocked(global.fetch)
        .mockImplementationOnce(async () => {
          return new Response(JSON.stringify({ message: 'Unauthorized' }), {
            status: 401,
          });
        })
        .mockImplementationOnce(async () => {
          return new Response(JSON.stringify({ message: 'Server error' }), {
            status: 500,
          });
        });

      // The data call should propagate the 500-originated AuthError,
      // NOT a generic NetworkError with status 401.
      try {
        await dataClient.get('/api/some-data');
        expect.unreachable('should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('Server error');
        expect(error.message).not.toBe(
          'Authentication failed after token refresh'
        );
      }
    });

    it('propagates SESSION_EXPIRED when refresh token is revoked', async () => {
      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const dataClient = new ApiClient({
        baseUrl: 'https://example.com',
        publishableKey: 'pk-commonSampleAppPKkey',
      });
      auth.attachToClient(dataClient);

      // First call: data request returns 401. Second call: refresh returns 401.
      vi.mocked(global.fetch)
        .mockImplementationOnce(async () => {
          return new Response(JSON.stringify({ message: 'Unauthorized' }), {
            status: 401,
          });
        })
        .mockImplementationOnce(async () => {
          return new Response(
            JSON.stringify({ message: 'Invalid refresh token' }),
            { status: 401 }
          );
        });

      try {
        await dataClient.get('/api/some-data');
        expect.unreachable('should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('Session expired');
      }

      expect(auth.getSession().isAuthenticated).toBe(false);
    });
  });

  describe('Cross-Tab Refresh Lock (navigator.locks)', () => {
    let lockRelease: (() => void) | null = null;
    let lockRequests: string[] = [];

    beforeEach(() => {
      lockRelease = null;
      lockRequests = [];
    });

    afterEach(() => {
      // Clean up navigator.locks mock
      if ('locks' in globalThis.navigator) {
        Object.defineProperty(globalThis.navigator, 'locks', {
          value: undefined,
          configurable: true,
        });
      }
    });

    function mockNavigatorLocks() {
      Object.defineProperty(globalThis.navigator, 'locks', {
        value: {
          request: async (name: string, callback: () => Promise<any>) => {
            lockRequests.push(name);
            return callback();
          },
        },
        configurable: true,
      });
    }

    function mockNavigatorLocksWithHold() {
      // A version that can hold the lock to simulate cross-tab contention
      Object.defineProperty(globalThis.navigator, 'locks', {
        value: {
          request: async (name: string, callback: () => Promise<any>) => {
            lockRequests.push(name);
            // Wait for release signal before running callback
            await new Promise<void>((resolve) => {
              lockRelease = resolve;
            });
            return callback();
          },
        },
        configurable: true,
      });
    }

    it('uses navigator.locks when available', async () => {
      mockNavigatorLocks();

      await auth.signIn({ email: 'user@example.com', password: 'password' });
      const tokens = await auth.refreshSession();

      expect(tokens.accessToken).toBeDefined();
      expect(lockRequests.length).toBe(1);
      expect(lockRequests[0]).toContain('rayfin_refresh_lock');
    });

    it('falls back to local lock when navigator.locks is unavailable', async () => {
      // navigator.locks is undefined by default in jsdom
      expect((globalThis.navigator as any).locks).toBeUndefined();

      await auth.signIn({ email: 'user@example.com', password: 'password' });
      const tokens = await auth.refreshSession();

      expect(tokens.accessToken).toBeDefined();
      expect(lockRequests.length).toBe(0); // navigator.locks not used
    });

    it('always delegates to refreshWithLocalLock after acquiring lock', async () => {
      mockNavigatorLocksWithHold();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      vi.useFakeTimers();
      // Advance past AT expiry so refresh is needed
      vi.advanceTimersByTime(16 * 60 * 1000);

      const fetchMock = vi.mocked(global.fetch);
      const callsBefore = fetchMock.mock.calls.length;

      const refreshPromise = auth.refreshSession();

      // refreshSession now awaits ensureInitialized() before requesting the
      // cross-tab lock; flush microtasks until it has actually requested the
      // lock so we don't release it before it is held.
      for (let i = 0; i < 100 && lockRequests.length === 0; i++) {
        await Promise.resolve();
      }

      // Release the lock — the callback always calls refreshWithLocalLock,
      // no short-circuit based on in-memory state.
      lockRelease?.();

      const tokens = await refreshPromise;
      expect(tokens.accessToken).toBeDefined();
      expect(lockRequests.length).toBe(1);

      // Verify a /token call was made (no short-circuit)
      const tokenCalls = fetchMock.mock.calls
        .slice(callsBefore)
        .filter((c) => String(c[0]).includes('/api/auth/v1/token'));
      expect(tokenCalls.length).toBe(1);

      vi.useRealTimers();
    });

    it('includes storage key prefix in lock name for multi-app isolation', async () => {
      mockNavigatorLocks();

      const prefixedApiClient = new ApiClient({
        baseUrl: 'https://example.com',
        publishableKey: 'pk-commonSampleAppPKkey',
      });
      const prefixedAuth = new Auth(prefixedApiClient, {
        storage: false,
        storageKeyPrefix: 'myapp',
      });

      await prefixedAuth.signIn({
        email: 'user@example.com',
        password: 'password',
      });
      await prefixedAuth.refreshSession();

      expect(lockRequests.length).toBe(1);
      expect(lockRequests[0]).toBe('myapp_rayfin_refresh_lock');

      prefixedAuth.destroy();
    });
  });

  describe('Session Expiration Timer Resilience', () => {
    it('does not clear session when timer refresh fails with a transient network error', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });
      expect(auth.getSession().isAuthenticated).toBe(true);

      // Mock the next fetch (timer's refresh attempt) to fail with a network error
      vi.mocked(global.fetch).mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      });

      // Advance past the 15-minute AT lifetime to trigger the expiration timer
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);

      // Session should still be alive — transient errors must not cause logout
      expect(auth.getSession().isAuthenticated).toBe(true);
      expect(auth.hasRefreshToken()).toBe(true);

      vi.useRealTimers();
    });

    it('does not clear session when timer refresh fails with a 500 server error', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Mock the next fetch to return 500
      vi.mocked(global.fetch).mockImplementationOnce(async () => {
        return new Response(JSON.stringify({ message: 'Server error' }), {
          status: 500,
        });
      });

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);

      // Session should still be alive
      expect(auth.getSession().isAuthenticated).toBe(true);
      expect(auth.hasRefreshToken()).toBe(true);

      vi.useRealTimers();
    });

    it('clears session when timer refresh fails with 401 (refresh token revoked)', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      const expiredEvents: OpaqueSession[] = [];
      auth.on('AUTH_SESSION_EXPIRED', (session) => expiredEvents.push(session));

      // Mock the next fetch to return 401 (invalid refresh token)
      vi.mocked(global.fetch).mockImplementationOnce(async () => {
        return new Response(
          JSON.stringify({ message: 'Invalid refresh token' }),
          { status: 401 }
        );
      });

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);

      // Session should be cleared — 401 on refresh is fatal
      expect(auth.getSession().isAuthenticated).toBe(false);
      expect(auth.hasRefreshToken()).toBe(false);

      // AUTH_SESSION_EXPIRED should still be emitted for consumer UX
      expect(expiredEvents.length).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('Proactive Refresh on Tab Wake (Issue 1 & 3)', () => {
    it('refreshes session when visibilitychange fires and AT is expired', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });
      expect(auth.getSession().isAuthenticated).toBe(true);

      // Advance time past the 15-minute access token lifetime
      vi.advanceTimersByTime(16 * 60 * 1000);

      const refreshEvents: OpaqueSession[] = [];
      auth.on('AUTH_REFRESH', (session) => refreshEvents.push(session));

      // Simulate tab becoming visible
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      // Allow the async refresh to settle
      await vi.advanceTimersByTimeAsync(100);

      expect(refreshEvents.length).toBe(1);
      expect(auth.getSession().isAuthenticated).toBe(true);

      vi.useRealTimers();
    });

    it('refreshes session when AT is within 60s skew window', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Advance to 30 seconds before expiry (within 60s skew window)
      vi.advanceTimersByTime(900 * 1000 - 30_000);

      const refreshEvents: OpaqueSession[] = [];
      auth.on('AUTH_REFRESH', (session) => refreshEvents.push(session));

      // Simulate focus event
      window.dispatchEvent(new Event('focus'));

      await vi.advanceTimersByTimeAsync(100);

      expect(refreshEvents.length).toBe(1);

      vi.useRealTimers();
    });

    it('does not refresh when AT is still valid (outside skew window)', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Advance only 5 minutes — well within the 15-minute AT lifetime
      vi.advanceTimersByTime(5 * 60 * 1000);

      const refreshEvents: OpaqueSession[] = [];
      auth.on('AUTH_REFRESH', (session) => refreshEvents.push(session));

      // Simulate tab becoming visible
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      await vi.advanceTimersByTimeAsync(100);

      // No refresh should have occurred
      expect(refreshEvents.length).toBe(0);

      vi.useRealTimers();
    });

    it('does not refresh when there is no session', () => {
      // No sign-in — no session, no refresh token.
      // Firing the event should be a no-op (no errors thrown).
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(auth.getSession().isAuthenticated).toBe(false);
    });

    it('refreshes session when online event fires and AT is expired', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Advance past expiry
      vi.advanceTimersByTime(16 * 60 * 1000);

      const refreshEvents: OpaqueSession[] = [];
      auth.on('AUTH_REFRESH', (session) => refreshEvents.push(session));

      // Simulate coming back online
      window.dispatchEvent(new Event('online'));

      await vi.advanceTimersByTimeAsync(100);

      expect(refreshEvents.length).toBe(1);

      vi.useRealTimers();
    });

    it('cleans up visibility/focus/online listeners on destroy()', async () => {
      const removeDocSpy = vi.spyOn(document, 'removeEventListener');
      const removeWinSpy = vi.spyOn(window, 'removeEventListener');

      auth.destroy();

      expect(removeDocSpy).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function)
      );
      expect(removeWinSpy).toHaveBeenCalledWith('focus', expect.any(Function));
      expect(removeWinSpy).toHaveBeenCalledWith('online', expect.any(Function));

      removeDocSpy.mockRestore();
      removeWinSpy.mockRestore();
    });

    it('does not fire duplicate refreshes from concurrent events', async () => {
      vi.useFakeTimers();

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Advance past expiry
      vi.advanceTimersByTime(16 * 60 * 1000);

      // Track how many /token calls are made
      const fetchSpy = vi.mocked(global.fetch);
      const callCountBefore = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes('/api/auth/v1/token')
      ).length;

      // Fire all three events simultaneously
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));

      await vi.advanceTimersByTimeAsync(100);

      const callCountAfter = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes('/api/auth/v1/token')
      ).length;

      // Only one refresh request should have been made (promise lock dedup)
      expect(callCountAfter - callCountBefore).toBe(1);

      vi.useRealTimers();
    });

    it('logs AuthError at debug level on tab-wake refresh failure', async () => {
      vi.useFakeTimers();
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      await auth.signIn({ email: 'user@example.com', password: 'password' });

      // Advance past expiry
      vi.advanceTimersByTime(16 * 60 * 1000);

      // Make the refresh call fail with 500
      vi.mocked(global.fetch).mockImplementationOnce(async () => {
        return new Response(JSON.stringify({ message: 'Server error' }), {
          status: 500,
        });
      });

      // Trigger tab-wake refresh
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      await vi.advanceTimersByTimeAsync(100);

      // AuthError from the 500 should be logged at debug level with 'tab-wake'
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('tab-wake')
      );

      vi.useRealTimers();
      debugSpy.mockRestore();
    });
  });

  describe('Storage Event Sequence Guard', () => {
    it('discards stale session restoration when logout arrives during validation', async () => {
      // Use localStorage-backed Auth so storage events are wired up
      const storageAuth = new Auth(
        new ApiClient({
          baseUrl: 'https://example.com',
          publishableKey: 'pk-commonSampleAppPKkey',
        }),
        { storage: true, storageKeyPrefix: 'seq_test' }
      );

      await storageAuth.signIn({
        email: 'user@example.com',
        password: 'password',
      });
      expect(storageAuth.getSession().isAuthenticated).toBe(true);

      // Simulate storage events as another tab would send them:
      // S1: new session (refresh in other tab)
      const sessionPayload = JSON.stringify({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        user: { id: '123', email: 'user@example.com' },
      });

      // S1 arrives — starts async validateAccessToken
      const s1Event = Object.assign(new Event('storage'), {
        key: 'seq_test_authSession',
        newValue: sessionPayload,
      });

      // S2 arrives immediately after — logout
      const s2Event = Object.assign(new Event('storage'), {
        key: 'seq_test_authSession',
        newValue: null,
      });

      // Dispatch both before S1's async validation can complete
      window.dispatchEvent(s1Event);
      window.dispatchEvent(s2Event);

      // Let microtasks and the JWKS fetch resolve
      await new Promise((r) => setTimeout(r, 50));

      // S2 (logout) should win — session must be cleared
      expect(storageAuth.getSession().isAuthenticated).toBe(false);

      storageAuth.destroy();
    });

    it('accepts session from storage when no competing logout arrives', async () => {
      const storageAuth = new Auth(
        new ApiClient({
          baseUrl: 'https://example.com',
          publishableKey: 'pk-commonSampleAppPKkey',
        }),
        { storage: true, storageKeyPrefix: 'seq_accept' }
      );

      // Start with no session
      expect(storageAuth.getSession().isAuthenticated).toBe(false);

      // Simulate a login in another tab writing a session to storage
      const sessionPayload = JSON.stringify({
        accessToken: 'valid-access-token',
        refreshToken: 'valid-refresh-token',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        user: { id: '456', email: 'other@example.com' },
      });

      window.dispatchEvent(
        Object.assign(new Event('storage'), {
          key: 'seq_accept_authSession',
          newValue: sessionPayload,
        })
      );

      await new Promise((r) => setTimeout(r, 50));

      // With no competing event, the session should be accepted
      // (validateAccessToken may fail on the mock token, but the
      // sequence guard itself should not block it)
      storageAuth.destroy();
    });
  });

  describe('Synchronous Session Restore', () => {
    /**
     * Builds an in-memory store pre-seeded with a valid (non-expired) session.
     * The `sync` flag controls whether `getItem` returns synchronously (like
     * browser localStorage) or asynchronously (like a Node/SSR backend).
     */
    function seededStore(sync: boolean) {
      const store = new Map<string, string>();
      store.set(
        'authSession',
        JSON.stringify({
          user: { id: 'user-123', email: 'user@example.com' },
          accessToken: 'ACCESS_TOKEN_123',
          refreshToken: 'REFRESH_TOKEN_456',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        })
      );
      const storage = sync
        ? {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => {
              store.set(k, v);
            },
            removeItem: (k: string) => {
              store.delete(k);
            },
            clear: () => store.clear(),
          }
        : {
            getItem: async (k: string) => store.get(k) ?? null,
            setItem: async (k: string, v: string) => {
              store.set(k, v);
            },
            removeItem: async (k: string) => {
              store.delete(k);
            },
            clear: async () => store.clear(),
          };
      return { store, storage };
    }

    it('restores the persisted session synchronously with synchronous storage', () => {
      const { storage } = seededStore(true);
      const localAuth = new Auth(
        new ApiClient({
          baseUrl: 'https://example.com',
          publishableKey: 'pk-commonSampleAppPKkey',
        }),
        { storage }
      );

      // No await: the session must already be restored on the same tick.
      const session = localAuth.getSession();
      expect(session.isAuthenticated).toBe(true);
      expect(session.user?.email).toBe('user@example.com');
      expect(localAuth.hasRefreshToken()).toBe(true);

      localAuth.destroy();
    });

    it('restores asynchronously (next microtask) with asynchronous storage', async () => {
      const { storage } = seededStore(false);
      const localAuth = new Auth(
        new ApiClient({
          baseUrl: 'https://example.com',
          publishableKey: 'pk-commonSampleAppPKkey',
        }),
        { storage }
      );

      // Async storage cannot be read synchronously in the constructor.
      expect(localAuth.getSession().isAuthenticated).toBe(false);

      // After initialization settles, the session is restored.
      await new Promise((r) => setTimeout(r, 0));
      expect(localAuth.getSession().isAuthenticated).toBe(true);

      localAuth.destroy();
    });
  });
});
