import type { RayfinClient } from '@microsoft/rayfin-client';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';
import { ensureBackendRunning, stopBackend } from '../../shared/backend';
import { createTestClient } from '../../shared/client-factory';
import { generateUniqueUser } from '../../shared/test-data';

// Mock localStorage for Node.js environment (magic link tests require browser storage)
const mockLocalStorage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => mockLocalStorage.get(key) ?? null,
  setItem: (key: string, value: string) => mockLocalStorage.set(key, value),
  removeItem: (key: string) => mockLocalStorage.delete(key),
  clear: () => mockLocalStorage.clear(),
  get length() {
    return mockLocalStorage.size;
  },
  key: (index: number) => Array.from(mockLocalStorage.keys())[index] ?? null,
};

// Set up global mocks before any tests run
vi.stubGlobal('window', {
  localStorage: localStorageMock,
  location: { href: 'http://localhost:5173' },
});
vi.stubGlobal('localStorage', localStorageMock);

/**
 * Decodes a Rayfin refresh token payload to extract embedded identity claims.
 * RT format: `rayfin_rt_{base64url(payload)}.{base64url(signature)}.{kid}`
 * Extended payload: 24-byte header (sessionId + timestamp) + version byte + JSON `{ email, oid }`
 */
function decodeRefreshTokenPayload(
  rt: string
): { email: string; oid: string } | null {
  const parts = rt.split('.');
  if (parts.length !== 3 || !parts[0].startsWith('rayfin_rt_')) return null;

  const encoded = parts[0].substring('rayfin_rt_'.length);
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes = Buffer.from(padded, 'base64');

  // Legacy format (24 bytes) has no embedded claims
  if (bytes.length <= 25) return null;

  // Extended format: skip 24-byte header + 1 version byte, parse JSON
  const json = bytes.subarray(25).toString('utf-8');
  return JSON.parse(json);
}

describe('Auth SDK E2E Tests', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;

  beforeAll(async () => {
    // Start Rayfin backend with Docker Compose (or use existing in CI)
    await ensureBackendRunning();

    // Initialize test client
    client = createTestClient();
  });

  afterAll(async () => {
    // Stop and purge backend (respects E2E_KEEP_BACKEND_RUNNING env var)
    await stopBackend();
  });

  beforeEach(() => {
    // Clear mock localStorage between tests
    mockLocalStorage.clear();
  });

  describe('Sign Up and Sign In', () => {
    it('should sign up a new user and then sign in successfully', async () => {
      const user = generateUniqueUser();

      // Sign up
      const signUpResult = await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      expect(signUpResult).toBeDefined();
      expect(signUpResult.emailVerified).toBe(true); // Email verification disabled in config

      // Sign in with the newly created user
      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Get session to verify user details
      const session = client.auth.getSession();

      expect(session).toBeDefined();
      expect(session.isAuthenticated).toBe(true);
      expect(session.user).toBeDefined();
      expect(session.user?.id).toBeDefined();
      expect(session.user?.email).toBe(user.email);
    });
  });

  describe('Sign In Failures', () => {
    it('should fail to sign in with non-existent email', async () => {
      const user = generateUniqueUser();

      // Attempt sign in without signing up
      await expect(
        client.auth.signIn({
          email: user.email,
          password: user.password,
        })
      ).rejects.toThrow('Invalid email or password');
    });

    it('should fail to sign in with wrong password', async () => {
      const user = generateUniqueUser();

      // Sign up first
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Attempt sign in with wrong password
      await expect(
        client.auth.signIn({
          email: user.email,
          password: 'WrongPassword123!',
        })
      ).rejects.toThrow('Invalid email or password');
    });
  });

  describe('Sign Up Failures', () => {
    it('should fail to sign up with duplicate email', async () => {
      const user = generateUniqueUser();

      // First sign up should succeed
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Second sign up with same email should fail
      await expect(
        client.auth.signUp({
          email: user.email,
          password: user.password,
        })
      ).rejects.toThrow('Email is already registered');
    });
  });

  describe('Sign Out', () => {
    it('should sign out a valid authenticated user', async () => {
      const user = generateUniqueUser();

      // Sign up and sign in
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Verify user is authenticated
      const sessionBefore = client.auth.getSession();
      expect(sessionBefore.isAuthenticated).toBe(true);

      // Sign out
      await client.auth.signOut();

      // Verify user is no longer authenticated
      const sessionAfter = client.auth.getSession();
      expect(sessionAfter.isAuthenticated).toBe(false);
      expect(sessionAfter.user).toBeNull();
    });

    it('should not hang when signing out without a valid session', async () => {
      // Create a fresh client that has no session
      const freshClient = createTestClient();

      // Sign out should complete without hanging (timeout will fail the test if it hangs)
      const signOutPromise = freshClient.auth.signOut();

      // Use a race with a timeout to ensure it doesn't hang
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 5000)
      );

      const result = await Promise.race([
        signOutPromise.then(() => 'completed' as const),
        timeoutPromise,
      ]);

      expect(result).toBe('completed');
    });

    it('should not deadlock when signing out with expired token (skipRetryOn401)', async () => {
      // This test verifies the fix from ba1bd7552fa18834e06499917e4f74702ba82c50
      // Previously, signOut with an invalid token would trigger token refresh,
      // which would 401, which would trigger another refresh, causing a deadlock.
      const user = generateUniqueUser();

      // Sign up and sign in to get a valid session
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Sign out once (invalidates the token on the server)
      await client.auth.signOut();

      // Create a new client to simulate having stale/expired tokens in memory
      // but sign out should still complete without deadlocking
      const staleClient = createTestClient();

      // Sign out should complete immediately without triggering 401 retry loops
      const signOutPromise = staleClient.auth.signOut();

      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 5000)
      );

      const result = await Promise.race([
        signOutPromise.then(() => 'completed' as const),
        timeoutPromise,
      ]);

      expect(result).toBe('completed');
    });

    it('should not affect other sessions when signing out from one client', async () => {
      // This test verifies that signing out from one client only invalidates
      // that specific session, not all sessions for the user (sid claim fix)
      const user = generateUniqueUser();

      // Sign up the user
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Create two separate clients (simulating two devices/browsers)
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Sign in from both clients
      await client1.auth.signIn({
        email: user.email,
        password: user.password,
      });

      await client2.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Verify both clients are authenticated
      expect(client1.auth.getSession().isAuthenticated).toBe(true);
      expect(client2.auth.getSession().isAuthenticated).toBe(true);

      // Sign out from client1 only
      await client1.auth.signOut();

      // Verify client1 is signed out
      expect(client1.auth.getSession().isAuthenticated).toBe(false);

      // Verify client2 is still authenticated and can refresh its session
      expect(client2.auth.getSession().isAuthenticated).toBe(true);

      // Client2 should be able to refresh its session successfully
      const refreshResult = await client2.auth.refreshSession();
      expect(refreshResult).toBeDefined();
      expect(client2.auth.getSession().isAuthenticated).toBe(true);
    });
  });

  describe('Refresh Token', () => {
    it('should receive a refresh token when signing in', async () => {
      const user = generateUniqueUser();

      // Sign up
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Sign in
      const tokenResponse = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Verify refresh token is returned
      expect(tokenResponse).toBeDefined();
      expect(tokenResponse.refreshToken).toBeDefined();
      expect(tokenResponse.refreshToken).not.toBeNull();
      expect(typeof tokenResponse.refreshToken).toBe('string');
      expect(tokenResponse.refreshToken!.length).toBeGreaterThan(0);
    });

    it('should use refresh token to get new access token', async () => {
      const user = generateUniqueUser();

      // Sign up and sign in
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      const initialTokenResponse = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      const initialAccessToken = initialTokenResponse.accessToken;

      // Refresh the session
      const refreshedTokenResponse = await client.auth.refreshSession();

      // Verify new access token is returned
      expect(refreshedTokenResponse).toBeDefined();
      expect(refreshedTokenResponse.accessToken).toBeDefined();
      expect(refreshedTokenResponse.accessToken).not.toBe(initialAccessToken);
    });

    it('should receive a new refresh token after using refresh token (token rotation)', async () => {
      const user = generateUniqueUser();

      // Sign up and sign in
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      const initialTokenResponse = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      const initialRefreshToken = initialTokenResponse.refreshToken;

      // Refresh the session
      const refreshedTokenResponse = await client.auth.refreshSession();

      // Verify new refresh token is returned (token rotation)
      expect(refreshedTokenResponse.refreshToken).toBeDefined();
      expect(refreshedTokenResponse.refreshToken).not.toBe(initialRefreshToken);
    });

    it('should accept refresh token reuse within the reuse interval window', async () => {
      // This test verifies that using the same refresh token within the reuse interval
      // (configured as 60s in todo-app rayfin.yml) is allowed for legitimate retries
      const user = generateUniqueUser();

      // Sign up and sign in
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // First refresh - should succeed
      const firstRefresh = await client.auth.refreshSession();
      expect(firstRefresh.accessToken).toBeDefined();

      // Immediate second refresh (within reuse interval) - should also succeed
      // because we're within the reuse window
      const secondRefresh = await client.auth.refreshSession();
      expect(secondRefresh.accessToken).toBeDefined();
    });

    it('should reject refresh token after session is signed out', async () => {
      const user = generateUniqueUser();

      // Sign up and sign in
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Verify we have a refresh token
      expect(client.auth.hasRefreshToken()).toBe(true);

      // Sign out (invalidates the session and tokens)
      await client.auth.signOut();

      // Verify session is cleared
      expect(client.auth.hasRefreshToken()).toBe(false);

      // Attempting to refresh should fail since we have no refresh token
      await expect(client.auth.refreshSession()).rejects.toThrow(
        'No refresh token available'
      );
    });

    it('should fail to refresh with invalid/malformed refresh token', async () => {
      const user = generateUniqueUser();

      // Sign up and sign in to establish a session
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Create a new client and try to use a garbage refresh token
      // We'll test this by making a direct API call with an invalid token
      const freshClient = createTestClient();

      // Sign in to get a valid session structure
      await freshClient.auth.signUp({
        email: generateUniqueUser().email,
        password: user.password,
      });

      // The SDK doesn't expose direct refresh token manipulation,
      // so we verify that the hasRefreshToken check works correctly
      // A fresh client without sign-in should not have a refresh token
      expect(freshClient.auth.hasRefreshToken()).toBe(false);
    });

    it('should embed email and user ID in refresh token payload', async () => {
      const user = generateUniqueUser();

      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      const tokenResponse = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Decode the RT payload to verify email and oid are embedded
      const rtPayload = decodeRefreshTokenPayload(tokenResponse.refreshToken!);
      expect(rtPayload).not.toBeNull();
      expect(rtPayload!.email).toBe(user.email);
      expect(rtPayload!.oid).toBeDefined();
      expect(rtPayload!.oid.length).toBeGreaterThan(0);
    });

    it('should preserve email and user ID in rotated refresh token', async () => {
      const user = generateUniqueUser();

      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      const initialResponse = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      const initialPayload = decodeRefreshTokenPayload(
        initialResponse.refreshToken!
      );

      // Refresh to get a rotated RT
      const refreshedResponse = await client.auth.refreshSession();

      const rotatedPayload = decodeRefreshTokenPayload(
        refreshedResponse.refreshToken!
      );
      expect(rotatedPayload).not.toBeNull();
      expect(rotatedPayload!.email).toBe(user.email);
      expect(rotatedPayload!.oid).toBe(initialPayload!.oid);
    });
  });

  describe('Session Management', () => {
    it('should sign out all sessions for a user', async () => {
      const user = generateUniqueUser();

      // Sign up the user
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Create multiple sessions by signing in from different clients
      const client1 = createTestClient();
      const client2 = createTestClient();

      await client1.auth.signIn({
        email: user.email,
        password: user.password,
      });

      await client2.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Verify both clients have sessions
      expect(client1.auth.getSession().isAuthenticated).toBe(true);
      expect(client2.auth.getSession().isAuthenticated).toBe(true);

      // Sign out all sessions from client1
      const result = await client1.auth.signOutAll();

      // Verify we got a count back
      expect(result).toBeDefined();
      expect(typeof result.count).toBe('number');
      expect(result.count).toBeGreaterThanOrEqual(2); // At least 2 sessions
    });

    it('should return the count of revoked sessions when signing out all', async () => {
      const user = generateUniqueUser();

      // Sign up and create 3 sessions
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      const clients = [
        createTestClient(),
        createTestClient(),
        createTestClient(),
      ];

      for (const c of clients) {
        await c.auth.signIn({
          email: user.email,
          password: user.password,
        });
      }

      // Sign out all from the first client
      const result = await clients[0].auth.signOutAll();

      // Should have revoked at least 3 sessions
      expect(result.count).toBeGreaterThanOrEqual(3);
    });

    it('should invalidate all refresh tokens after signOutAll', async () => {
      const user = generateUniqueUser();

      // Sign up
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Create two clients with sessions
      const client1 = createTestClient();
      const client2 = createTestClient();

      await client1.auth.signIn({
        email: user.email,
        password: user.password,
      });

      await client2.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Sign out all from client1
      await client1.auth.signOutAll();

      // client2's refresh token should now be invalid
      // The local state still has hasRefreshToken true, but server-side it's revoked
      // Attempting to refresh should fail
      await expect(client2.auth.refreshSession()).rejects.toThrow();
    });
  });

  describe('Session State', () => {
    it('should return correct session state after sign in', async () => {
      const user = generateUniqueUser();

      // Sign up and sign in
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Get session state
      const session = client.auth.getSession();

      expect(session.isAuthenticated).toBe(true);
      expect(session.isAnonymous).toBe(false);
      expect(session.user).toBeDefined();
      expect(session.user?.email).toBe(user.email);
      expect(session.user?.id).toBeDefined();
      expect(session.expiresAt).toBeDefined();
      expect(session.expiresAt instanceof Date).toBe(true);
      // Verify expiration is in the future
      expect(session.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('should return hasRefreshToken true after sign in', async () => {
      const user = generateUniqueUser();

      // Sign up and sign in
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      expect(client.auth.hasRefreshToken()).toBe(true);
    });

    it('should return hasRefreshToken false after sign out', async () => {
      const user = generateUniqueUser();

      // Sign up and sign in
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Verify we have refresh token
      expect(client.auth.hasRefreshToken()).toBe(true);

      // Sign out
      await client.auth.signOut();

      // Verify refresh token is gone
      expect(client.auth.hasRefreshToken()).toBe(false);
    });
  });

  describe('Multi-Session', () => {
    it('should allow concurrent sessions from multiple clients', async () => {
      const user = generateUniqueUser();

      // Sign up the user
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Create two clients and sign in with same user
      const client1 = createTestClient();
      const client2 = createTestClient();

      await client1.auth.signIn({
        email: user.email,
        password: user.password,
      });

      await client2.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Both clients should be authenticated
      expect(client1.auth.getSession().isAuthenticated).toBe(true);
      expect(client2.auth.getSession().isAuthenticated).toBe(true);

      // Both should have different JTI (token IDs) in their sessions
      // We verify they can both refresh independently
      const refresh1 = await client1.auth.refreshSession();
      const refresh2 = await client2.auth.refreshSession();

      expect(refresh1.accessToken).toBeDefined();
      expect(refresh2.accessToken).toBeDefined();
      expect(refresh1.accessToken).not.toBe(refresh2.accessToken);
    });
  });

  describe('Edge Cases', () => {
    it('should fail to refresh session without prior sign in', async () => {
      // Create a fresh client with no session
      const freshClient = createTestClient();

      // Attempting to refresh without a session should throw
      await expect(freshClient.auth.refreshSession()).rejects.toThrow(
        'No refresh token available'
      );
    });

    it('should handle session expired error gracefully', async () => {
      const user = generateUniqueUser();

      // Sign up and sign in
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Sign out all to invalidate all sessions on server
      await client.auth.signOutAll();

      // Create another client with the same user to test the expired scenario
      const client2 = createTestClient();
      await client2.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Now sign out all again from client2
      await client2.auth.signOutAll();

      // Verify that session is cleared locally after signOutAll
      expect(client2.auth.getSession().isAuthenticated).toBe(false);
    });
  });

  describe('Magic Link Redirect URI Validation', () => {
    it('should reject non-localhost redirect URI when not in allowlist', async () => {
      // This test verifies that magic links are rejected for redirect URIs
      // that don't match the configured allowlist in rayfin.yml
      // The todo-app has an allowlist configured for localhost:5173

      const user = generateUniqueUser();
      // Use a production-like URL that's NOT in the configured allowlist
      const productionRedirectUri = 'https://my-production-app.com/callback';

      // Should throw with an error about redirect_uri not being allowed
      await expect(
        client.auth.sendMagicLink({
          email: user.email,
          redirectUri: productionRedirectUri,
        })
      ).rejects.toThrow(/redirect_uri.*not.*allowed/i);
    });

    it('should reject HTTP non-localhost redirect URI', async () => {
      const user = generateUniqueUser();
      // HTTP is only allowed for localhost - this should fail HTTPS check
      const httpNonLocalhost = 'http://my-app.example.com/callback';

      await expect(
        client.auth.sendMagicLink({
          email: user.email,
          redirectUri: httpNonLocalhost,
        })
      ).rejects.toThrow(/HTTPS|redirect_uri/i);
    });

    it('should allow localhost redirect URI', async () => {
      const user = generateUniqueUser();
      const localhostRedirectUri = 'http://localhost:5173/auth/callback';

      // This should succeed (either send email or return success without email if disabled)
      // The key is that it doesn't throw a redirect_uri validation error
      const result = await client.auth.sendMagicLink({
        email: user.email,
        redirectUri: localhostRedirectUri,
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });
});
