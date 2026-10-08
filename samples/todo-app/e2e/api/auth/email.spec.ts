import type { RayfinClient } from '@microsoft/rayfin-client';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

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
  extractTokenFromEmail,
  deleteAllEmails,
} from '../../shared/maildev';
import { generateUniqueUser } from '../../shared/test-data';

/**
 * Email verification and password reset E2E tests
 *
 * These tests verify the email verification and password reset flows work correctly.
 * They require the backend to be started with email enabled (AUTH_EMAIL_ENABLED=true),
 * which enables the MailDev container for email testing.
 *
 * To run these tests locally:
 * 1. Start the backend with email: AUTH_EMAIL_ENABLED=true rushx rayfin:dev:local
 * 2. Run tests: rushx test:e2e:api
 *
 * Tests will be automatically skipped if MailDev is not available.
 */
describe('Email Verification and Password Reset E2E Tests', () => {
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
          '⚠️ MailDev still not available after restart - email tests cannot run.';
        // In CI, a missing MailDev means the backend/email stack is broken.
        // Failing loudly is far better than silently skipping every test.
        if (process.env.CI === 'true') {
          throw new Error(msg);
        }
        console.log(msg + ' (skipping tests locally)');
        return;
      }
    }

    console.log('✅ MailDev is available - running email tests');

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
  });

  describe('Email Verification', () => {
    it('should sign up with email verification required and verify email', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();

      // Sign up - should not be verified yet when email is enabled
      const signUpResult = await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      expect(signUpResult).toBeDefined();
      // Email verification is enabled, so user should NOT be verified after signup
      expect(signUpResult.emailVerified).toBe(false);

      // Wait for verification email
      const verificationEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });

      expect(verificationEmail).toBeDefined();
      expect(verificationEmail.subject.toLowerCase()).toContain('verify');

      // Extract token from email
      const token = extractTokenFromEmail(verificationEmail);
      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(0);

      // Verify the email
      const verifyResult = await client.auth.verifyEmail(token);

      expect(verifyResult).toBeDefined();
      expect(verifyResult.success).toBe(true);
    });

    it('should resend verification email', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();

      // Sign up
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Wait for initial verification email
      const firstEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });
      expect(firstEmail).toBeDefined();

      // Clear emails
      await deleteAllEmails();

      // Resend verification email
      const resendResult = await client.auth.resendVerificationEmail(
        user.email
      );

      expect(resendResult).toBeDefined();
      expect(resendResult.success).toBe(true);

      // Wait for resent verification email
      const secondEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });

      expect(secondEmail).toBeDefined();
      expect(secondEmail.id).not.toBe(firstEmail.id); // Should be a new email
    });

    it('should fail to verify with invalid token', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const invalidToken = 'invalid-token-12345';

      await expect(client.auth.verifyEmail(invalidToken)).rejects.toThrow();
    });

    it('should invalidate old verification token when new one is requested', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();

      // Sign up
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Wait for initial verification email
      const firstEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });
      const firstToken = extractTokenFromEmail(firstEmail);

      // Clear emails and request a new verification email
      await deleteAllEmails();
      await client.auth.resendVerificationEmail(user.email);

      // Wait for second verification email
      const secondEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });
      const secondToken = extractTokenFromEmail(secondEmail);

      // Tokens should be different
      expect(secondToken).not.toBe(firstToken);

      // Old token should be invalid now
      await expect(client.auth.verifyEmail(firstToken)).rejects.toThrow();

      // New token should still work
      const verifyResult = await client.auth.verifyEmail(secondToken);
      expect(verifyResult.success).toBe(true);
    });

    it('should allow sign in after email verification', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();

      // Sign up
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Wait for and extract verification token
      const verificationEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });
      const token = extractTokenFromEmail(verificationEmail);

      // Verify email
      await client.auth.verifyEmail(token);

      // Create a fresh client for sign in
      const signInClient = createTestClient();

      // Sign in should now work
      await signInClient.auth.signIn({
        email: user.email,
        password: user.password,
      });

      const session = signInClient.auth.getSession();
      expect(session.isAuthenticated).toBe(true);
      expect(session.user?.email).toBe(user.email);
    });

    it('should fail to sign in if email is not verified', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();

      // Sign up - email will not be verified
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Wait for verification email to ensure signup completed
      await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });

      // Try to sign in without verifying email - should fail
      const signInClient = createTestClient();

      await expect(
        signInClient.auth.signIn({
          email: user.email,
          password: user.password,
        })
      ).rejects.toThrow();
    });
  });

  describe('Password Reset', () => {
    it('should request and complete password reset', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const newPassword = 'NewSecurePassword123!';

      // Sign up and verify email first
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      // Wait for and verify email
      const verificationEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });
      const verifyToken = extractTokenFromEmail(verificationEmail);
      await client.auth.verifyEmail(verifyToken);

      // Clear emails
      await deleteAllEmails();

      // Request password reset
      const resetResult = await client.auth.requestPasswordReset(user.email);

      expect(resetResult).toBeDefined();
      expect(resetResult.success).toBe(true);

      // Wait for password reset email
      const resetEmail = await waitForEmail(user.email, {
        subjectContains: 'reset',
        timeoutMs: 30_000,
      });

      expect(resetEmail).toBeDefined();
      expect(resetEmail.subject.toLowerCase()).toContain('reset');

      // Extract reset token
      const resetToken = extractTokenFromEmail(resetEmail);
      expect(resetToken).toBeDefined();

      // Complete password reset
      const completeResult = await client.auth.completePasswordReset(
        resetToken,
        newPassword
      );

      expect(completeResult).toBeDefined();
      expect(completeResult.success).toBe(true);

      // Create a fresh client and sign in with new password
      const signInClient = createTestClient();

      await signInClient.auth.signIn({
        email: user.email,
        password: newPassword,
      });

      const session = signInClient.auth.getSession();
      expect(session.isAuthenticated).toBe(true);
    });

    it('should fail to sign in with old password after reset', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const newPassword = 'NewSecurePassword456!';

      // Sign up and verify email
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      const verificationEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });
      const verifyToken = extractTokenFromEmail(verificationEmail);
      await client.auth.verifyEmail(verifyToken);

      // Clear emails and request password reset
      await deleteAllEmails();
      await client.auth.requestPasswordReset(user.email);

      // Get reset token and complete reset
      const resetEmail = await waitForEmail(user.email, {
        subjectContains: 'reset',
        timeoutMs: 30_000,
      });
      const resetToken = extractTokenFromEmail(resetEmail);
      await client.auth.completePasswordReset(resetToken, newPassword);

      // Try to sign in with old password - should fail
      const oldPasswordClient = createTestClient();

      await expect(
        oldPasswordClient.auth.signIn({
          email: user.email,
          password: user.password, // old password
        })
      ).rejects.toThrow();
    });

    it('should fail to reset password with invalid token', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const invalidToken = 'invalid-reset-token-12345';
      const newPassword = 'NewPassword123!';

      await expect(
        client.auth.completePasswordReset(invalidToken, newPassword)
      ).rejects.toThrow();
    });

    it('should invalidate old reset token when new one is requested', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      const user = generateUniqueUser();
      const newPassword = 'NewSecurePassword789!';

      // Sign up and verify email
      await client.auth.signUp({
        email: user.email,
        password: user.password,
      });

      const verificationEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });
      const verifyToken = extractTokenFromEmail(verificationEmail);
      await client.auth.verifyEmail(verifyToken);

      // Clear emails and request first password reset
      await deleteAllEmails();
      await client.auth.requestPasswordReset(user.email);

      // Wait for first reset email
      const firstResetEmail = await waitForEmail(user.email, {
        subjectContains: 'reset',
        timeoutMs: 30_000,
      });
      const firstResetToken = extractTokenFromEmail(firstResetEmail);

      // Clear emails and request another password reset
      await deleteAllEmails();
      await client.auth.requestPasswordReset(user.email);

      // Wait for second reset email
      const secondResetEmail = await waitForEmail(user.email, {
        subjectContains: 'reset',
        timeoutMs: 30_000,
      });
      const secondResetToken = extractTokenFromEmail(secondResetEmail);

      // Tokens should be different
      expect(secondResetToken).not.toBe(firstResetToken);

      // Old token should be invalid now
      await expect(
        client.auth.completePasswordReset(firstResetToken, newPassword)
      ).rejects.toThrow();

      // New token should still work
      const completeResult = await client.auth.completePasswordReset(
        secondResetToken,
        newPassword
      );
      expect(completeResult.success).toBe(true);
    });

    it('should return success for password reset request even for non-existent email', async (ctx) => {
      if (skipIfEmailDisabled(ctx)) return;

      // For security, password reset requests should always return success
      // to prevent email enumeration attacks
      const nonExistentEmail = `nonexistent-${Date.now()}@example.com`;

      const result = await client.auth.requestPasswordReset(nonExistentEmail);

      // Should return success (security: no information leakage)
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });
});
