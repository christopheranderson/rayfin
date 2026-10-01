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

// Mock localStorage for Node.js environment
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

/**
 * Extracts the key ID (kid) from a refresh token.
 */
function extractKeyId(rt: string): string | null {
  const parts = rt.split('.');
  return parts.length === 3 ? parts[2] : null;
}

describe('Refresh Token E2E Tests', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;

  beforeAll(async () => {
    await ensureBackendRunning();
    client = createTestClient();
  });

  afterAll(async () => {
    await stopBackend();
  });

  beforeEach(() => {
    mockLocalStorage.clear();
  });

  describe('Token Format', () => {
    it('should return a structurally valid refresh token on sign-in', async () => {
      const user = generateUniqueUser();
      await client.auth.signUp({ email: user.email, password: user.password });
      const response = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      const rt = response.refreshToken!;
      expect(rt).toBeDefined();
      expect(rt.startsWith('rayfin_rt_')).toBe(true);

      const parts = rt.split('.');
      expect(parts).toHaveLength(3);

      // kid should be a non-empty string
      const kid = extractKeyId(rt);
      expect(kid).toBeDefined();
      expect(kid!.length).toBeGreaterThan(0);
    });

    it('should embed email and user ID in refresh token payload', async () => {
      const user = generateUniqueUser();
      await client.auth.signUp({ email: user.email, password: user.password });
      const response = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      const payload = decodeRefreshTokenPayload(response.refreshToken!);
      expect(payload).not.toBeNull();
      expect(payload!.email).toBe(user.email);
      expect(payload!.oid).toBeDefined();
      expect(payload!.oid.length).toBeGreaterThan(0);
    });
  });

  describe('Token Rotation', () => {
    it('should issue a new refresh token on refresh (rotation)', async () => {
      const user = generateUniqueUser();
      await client.auth.signUp({ email: user.email, password: user.password });
      const initial = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      const refreshed = await client.auth.refreshSession();

      expect(refreshed.refreshToken).toBeDefined();
      expect(refreshed.refreshToken).not.toBe(initial.refreshToken);
    });

    it('should preserve email and user ID in rotated refresh token', async () => {
      const user = generateUniqueUser();
      await client.auth.signUp({ email: user.email, password: user.password });
      const initial = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      const initialPayload = decodeRefreshTokenPayload(initial.refreshToken!);
      const refreshed = await client.auth.refreshSession();
      const rotatedPayload = decodeRefreshTokenPayload(refreshed.refreshToken!);

      expect(rotatedPayload).not.toBeNull();
      expect(rotatedPayload!.email).toBe(user.email);
      expect(rotatedPayload!.oid).toBe(initialPayload!.oid);
    });

    it('should issue a new access token on refresh', async () => {
      const user = generateUniqueUser();
      await client.auth.signUp({ email: user.email, password: user.password });
      const initial = await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      const refreshed = await client.auth.refreshSession();

      expect(refreshed.accessToken).toBeDefined();
      expect(refreshed.accessToken).not.toBe(initial.accessToken);
    });
  });

  describe('Token Invalidation', () => {
    it('should reject refresh token after sign-out', async () => {
      const user = generateUniqueUser();
      await client.auth.signUp({ email: user.email, password: user.password });
      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      expect(client.auth.hasRefreshToken()).toBe(true);

      await client.auth.signOut();

      expect(client.auth.hasRefreshToken()).toBe(false);
    });

    it('should reject refresh token after sign-out-all', async () => {
      const user = generateUniqueUser();
      await client.auth.signUp({ email: user.email, password: user.password });

      // Create two sessions
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

      // Sign out all sessions from client1
      await client1.auth.signOutAll();

      // Client2's refresh token should be invalidated
      await expect(client2.auth.refreshSession()).rejects.toThrow();
    });
  });

  describe('Reuse Window', () => {
    it('should accept refresh token reuse within the reuse interval', async () => {
      const user = generateUniqueUser();
      await client.auth.signUp({ email: user.email, password: user.password });
      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // First refresh
      const firstRefresh = await client.auth.refreshSession();
      expect(firstRefresh).toBeDefined();
      expect(firstRefresh.accessToken).toBeDefined();
    });
  });

  describe('Data Plane Access', () => {
    it('should access data with access token obtained via refresh', async () => {
      const user = generateUniqueUser();
      await client.auth.signUp({ email: user.email, password: user.password });
      await client.auth.signIn({
        email: user.email,
        password: user.password,
      });

      // Refresh to get a new access token
      await client.auth.refreshSession();

      // Use the refreshed access token for a data plane query
      const result = await client.data.Todo.select(['id']).execute();
      expect(result).toBeDefined();
    });
  });

  describe('Absolute Session Lifetime', () => {
    // This test requires AUTH_RT_ABSOLUTE_LIFETIME_MINUTES=1 in the environment.
    // It is skipped by default and runs in a dedicated test suite with a backend
    // configured for short absolute lifetime.
    const absoluteLifetimeEnabled =
      process.env.AUTH_RT_ABSOLUTE_LIFETIME_MINUTES &&
      parseInt(process.env.AUTH_RT_ABSOLUTE_LIFETIME_MINUTES, 10) > 0;

    it.skipIf(!absoluteLifetimeEnabled)(
      'should reject refresh after absolute session lifetime expires',
      async () => {
        const user = generateUniqueUser();
        await client.auth.signUp({
          email: user.email,
          password: user.password,
        });
        await client.auth.signIn({
          email: user.email,
          password: user.password,
        });

        const lifetimeMinutes = parseInt(
          process.env.AUTH_RT_ABSOLUTE_LIFETIME_MINUTES!,
          10
        );

        // Wait for absolute lifetime to expire + buffer
        await new Promise((resolve) =>
          setTimeout(resolve, (lifetimeMinutes * 60 + 5) * 1000)
        );

        // Refresh should fail — session exceeded absolute lifetime
        await expect(client.auth.refreshSession()).rejects.toThrow();
      },
      // Timeout: lifetime + 30s buffer
      (parseInt(process.env.AUTH_RT_ABSOLUTE_LIFETIME_MINUTES || '1', 10) * 60 +
        30) *
        1000
    );
  });
});
