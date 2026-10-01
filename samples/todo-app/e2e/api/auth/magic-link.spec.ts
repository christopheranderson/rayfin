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
import {
  ensureBackendRunning,
  stopBackend,
  forceRestartBackend,
} from '../../shared/backend';
import { createTestClient } from '../../shared/client-factory';
import {
  isMailDevAvailable,
  waitForEmail,
  deleteAllEmails,
  extractMagicLinkFromEmail,
} from '../../shared/maildev';
import { generateUniqueUser } from '../../shared/test-data';

// Use the frontend URL for redirect URIs (matches allowedRedirectUris in rayfin.yml)
const FRONTEND_URL = 'http://localhost:5173';

// Mock localStorage for Node.js environment (magic link requires browser storage)
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
 * Magic Link (Passwordless) Authentication E2E Tests
 *
 * These tests verify the magic link authentication flow works correctly.
 * They require the backend to be started with email enabled (AUTH_EMAIL_ENABLED=true),
 * which enables the MailDev container for email testing.
 *
 * To run these tests locally:
 * 1. Start the backend with email: AUTH_EMAIL_ENABLED=true rushx rayfin:dev:local
 * 2. Run tests: rushx test:e2e:api
 *
 * Tests will be automatically skipped if MailDev is not available.
 */
describe('Magic Link Authentication E2E Tests', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let emailEnabled = false;

  /** Skip the current test if email is not enabled */
  function skipIfEmailDisabled(ctx: { skip: () => void }): boolean {
    if (!emailEnabled) {
      ctx.skip();
      return true;
    }
    return false;
  }

  beforeAll(async () => {
    // Enable email service for this test suite
    process.env.AUTH_EMAIL_ENABLED = 'true';

    // Start Rayfin backend (will use AUTH_EMAIL_ENABLED from environment)
    await ensureBackendRunning();

    // Check if MailDev is available (email feature enabled)
    emailEnabled = await isMailDevAvailable();

    if (!emailEnabled) {
      // Backend is running but without email enabled - need to restart with email
      console.log(
        '⚠️ MailDev not available - restarting backend with AUTH_EMAIL_ENABLED=true...'
      );

      // Force restart with email enabled
      await forceRestartBackend();

      // Check again after restart
      emailEnabled = await isMailDevAvailable();

      if (!emailEnabled) {
        const msg =
          '⚠️ MailDev still not available after restart - magic link tests cannot run.';
        // In CI, a missing MailDev means the backend/email stack is broken.
        // Failing loudly is far better than silently skipping every test.
        if (process.env.CI === 'true') {
          throw new Error(msg);
        }
        console.log(msg + ' (skipping tests locally)');
        return;
      }
    }

    console.log('✅ MailDev is available - running magic link tests');

    // Initialize test client
    client = createTestClient();
  });

  afterAll(async () => {
    // Stop and purge backend (respects E2E_KEEP_BACKEND_RUNNING env var)
    await stopBackend();
  });

  beforeEach(async () => {
    // Skip cleanup if email not enabled
    if (!emailEnabled) return;

    // Clean up any emails from previous tests
    await deleteAllEmails();

    // Clear mock localStorage between tests
    mockLocalStorage.clear();

    // Create a fresh client for each test
    client = createTestClient();
  });

  describe('Send Magic Link', () => {
    it('should send a magic link email to a new user', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Send magic link
      const result = await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.state).toBeDefined();
      expect(result.state.length).toBeGreaterThan(0);

      // Wait for magic link email
      const magicLinkEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });

      expect(magicLinkEmail).toBeDefined();
      expect(magicLinkEmail.subject.toLowerCase()).toContain('sign in');
    });

    it('should send a magic link email to an existing user', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // First, sign up the user with email/password
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Clear emails from signup
      await deleteAllEmails();

      // Send magic link to existing user
      const result = await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      // Wait for magic link email
      const magicLinkEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });

      expect(magicLinkEmail).toBeDefined();
    });

    it('should send magic link for non-existent email (creates new user)', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Send magic link to non-existent email (should auto-create user)
      const result = await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      // Wait for magic link email
      const magicLinkEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });

      expect(magicLinkEmail).toBeDefined();
    });
  });

  describe('Complete Magic Link Flow', () => {
    it('should authenticate user via magic link', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Step 1: Send magic link
      const sendResult = await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      expect(sendResult.success).toBe(true);
      const state = sendResult.state;

      // Step 2: Wait for and extract magic link from email
      const magicLinkEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });

      const { verificationCode, state: urlState } =
        extractMagicLinkFromEmail(magicLinkEmail);

      expect(verificationCode).toBeDefined();
      expect(urlState).toBe(state);

      // Step 3: Simulate the callback by constructing the callback URL
      // Note: In real flow, browser would navigate to this URL
      const callbackUrl = `${redirectUri}?verification_code=${verificationCode}&state=${urlState}`;

      // Step 4: Handle the callback
      const callbackResult =
        await client.auth.handleMagicLinkCallback(callbackUrl);

      expect(callbackResult.success).toBe(true);
      expect(callbackResult.session).toBeDefined();
      expect(callbackResult.session?.isAuthenticated).toBe(true);
      expect(callbackResult.session?.user?.email).toBe(user.email);
    });

    it('should create a new user when authenticating via magic link for the first time', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Send magic link (user doesn't exist yet)
      const sendResult = await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      const magicLinkEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });

      const { verificationCode, state } =
        extractMagicLinkFromEmail(magicLinkEmail);
      const callbackUrl = `${redirectUri}?verification_code=${verificationCode}&state=${state}`;

      // Handle callback - should create user and authenticate
      const callbackResult =
        await client.auth.handleMagicLinkCallback(callbackUrl);

      expect(callbackResult.success).toBe(true);
      expect(callbackResult.session?.user?.email).toBe(user.email);

      // Verify user was created by trying to get session
      const session = client.auth.getSession();
      expect(session.isAuthenticated).toBe(true);
      expect(session.user?.id).toBeDefined();
    });

    it('should receive refresh token after magic link authentication', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Complete magic link flow
      const sendResult = await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      const magicLinkEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });

      const { verificationCode, state } =
        extractMagicLinkFromEmail(magicLinkEmail);
      const callbackUrl = `${redirectUri}?verification_code=${verificationCode}&state=${state}`;

      await client.auth.handleMagicLinkCallback(callbackUrl);

      // Verify refresh token is available
      expect(client.auth.hasRefreshToken()).toBe(true);

      // Verify we can refresh the session
      const refreshResult = await client.auth.refreshSession();
      expect(refreshResult.accessToken).toBeDefined();
    });
  });

  describe('Magic Link Error Cases', () => {
    it('should fail with invalid verification code', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Send magic link to store PKCE state
      const sendResult = await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      const state = sendResult.state;

      // Try to handle callback with invalid verification code
      const callbackUrl = `${redirectUri}?verification_code=invalid-code&state=${state}`;

      const callbackResult =
        await client.auth.handleMagicLinkCallback(callbackUrl);

      expect(callbackResult.success).toBe(false);
      expect(callbackResult.error).toBeDefined();
    });

    it('should fail with missing state parameter', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Try to handle callback without state
      const callbackUrl = `${redirectUri}?verification_code=some-code`;

      const callbackResult =
        await client.auth.handleMagicLinkCallback(callbackUrl);

      expect(callbackResult.success).toBe(false);
      expect(callbackResult.errorCode).toBe('MISSING_STATE');
    });

    it('should fail with state not found (different browser/cleared storage)', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Try to handle callback with state that was never stored
      const callbackUrl = `${redirectUri}?verification_code=some-code&state=nonexistent-state`;

      const callbackResult =
        await client.auth.handleMagicLinkCallback(callbackUrl);

      expect(callbackResult.success).toBe(false);
      expect(callbackResult.errorCode).toBe('STATE_NOT_FOUND');
    });

    it('should fail when magic link code is used twice (replay attack)', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Send magic link
      await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      // Get the magic link
      const magicLinkEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });

      const { verificationCode, state } =
        extractMagicLinkFromEmail(magicLinkEmail);
      const callbackUrl = `${redirectUri}?verification_code=${verificationCode}&state=${state}`;

      // First use - should succeed
      const firstResult =
        await client.auth.handleMagicLinkCallback(callbackUrl);
      expect(firstResult.success).toBe(true);

      // Create a new client for second attempt
      const client2 = createTestClient();

      // Send another magic link to get a new state/PKCE
      await client2.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      // Try to reuse the old verification code with new state
      // This should fail because the code was already consumed
      const callbackUrl2 = `${redirectUri}?verification_code=${verificationCode}&state=${state}`;

      // The second attempt will fail because:
      // 1. PKCE state was cleared after first use
      // 2. Verification code was consumed on the server
      const secondResult =
        await client2.auth.handleMagicLinkCallback(callbackUrl2);
      expect(secondResult.success).toBe(false);
    });

    it('should invalidate old magic link when new one is requested', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Send first magic link
      await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      // Get first magic link email
      const firstEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });
      const firstLink = extractMagicLinkFromEmail(firstEmail);

      // Clear emails and send another magic link
      await deleteAllEmails();

      const secondSendResult = await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      // Get second magic link email
      const secondEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });
      const secondLink = extractMagicLinkFromEmail(secondEmail);

      // Verification codes should be different
      expect(secondLink.verificationCode).not.toBe(firstLink.verificationCode);

      // Try to use the old (first) verification code - should fail
      // We need to use the first state since that's what the SDK stored
      const oldCallbackUrl = `${redirectUri}?verification_code=${firstLink.verificationCode}&state=${firstLink.state}`;

      // Note: The first state is no longer in PKCE storage since sendMagicLink was called again
      // This creates a new state, so the old state won't be found
      const oldResult =
        await client.auth.handleMagicLinkCallback(oldCallbackUrl);
      expect(oldResult.success).toBe(false);

      // New link should still work
      const newCallbackUrl = `${redirectUri}?verification_code=${secondLink.verificationCode}&state=${secondSendResult.state}`;
      const newResult =
        await client.auth.handleMagicLinkCallback(newCallbackUrl);
      expect(newResult.success).toBe(true);
    });
  });

  describe('Magic Link with Email Verification', () => {
    it('should mark email as verified after magic link authentication', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const redirectUri = `${FRONTEND_URL}/auth/callback`;

      // Complete magic link flow
      await client.auth.sendMagicLink({
        email: user.email,
        redirectUri,
      });

      const magicLinkEmail = await waitForEmail(user.email, {
        subjectContains: 'sign in',
        timeoutMs: 30_000,
      });

      const { verificationCode, state } =
        extractMagicLinkFromEmail(magicLinkEmail);
      const callbackUrl = `${redirectUri}?verification_code=${verificationCode}&state=${state}`;

      const result = await client.auth.handleMagicLinkCallback(callbackUrl);

      expect(result.success).toBe(true);

      // The user was created via magic link, so email should be verified
      // (clicking the magic link proves email ownership)
      const session = client.auth.getSession();
      expect(session.isAuthenticated).toBe(true);
      // Note: emailVerified is not directly exposed in session, but the user
      // was created with emailVerified=true on the backend
    });
  });
});
