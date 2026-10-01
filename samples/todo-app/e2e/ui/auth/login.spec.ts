import type { Page } from '@playwright/test';

import { waitForEmail, extractTokenFromEmail } from '../../shared/maildev';
import { test, expect } from '../fixtures';

/**
 * Sign up a new user via the UI
 * Handles both email verification enabled and disabled scenarios
 * @returns true if email verification is required, false otherwise
 */
async function signUp(
  page: Page,
  frontendUrl: string,
  credentials: { email: string; password: string }
): Promise<boolean> {
  await page.goto(frontendUrl);

  // Switch to signup form
  await page
    .getByRole('button', { name: /need an account\? sign up/i })
    .click();

  // Fill and submit signup form
  await page.getByLabel(/email/i).fill(credentials.email);
  await page.getByLabel(/^password$/i).fill(credentials.password);
  await page.getByLabel(/confirm password/i).fill(credentials.password);
  await page.getByRole('button', { name: /sign up/i }).click();

  // Wait for success message - handles both email verification enabled and disabled
  // "Account Created Successfully!" when email verification is disabled
  // "Account Created!" when email verification is enabled
  await expect(
    page.getByRole('heading', { name: /account created/i })
  ).toBeVisible({ timeout: 10000 });

  // Check if we're seeing "Back to Sign In" (email verification required)
  // or "Go to Sign In" (no email verification needed)
  const backToSignInButton = page.getByRole('button', {
    name: /back to sign in/i,
  });
  return await backToSignInButton.isVisible().catch(() => false);
}

/**
 * Verify email by navigating to the verification link from MailDev
 */
async function verifyEmailFromMailDev(
  page: Page,
  frontendUrl: string,
  email: string
): Promise<void> {
  // Wait for verification email
  const verificationEmail = await waitForEmail(email, {
    subjectContains: 'verify',
    timeoutMs: 30_000,
  });

  // Extract token from email
  const token = extractTokenFromEmail(verificationEmail);

  // Navigate to verification URL
  await page.goto(`${frontendUrl}/verify-email?token=${token}`);

  // Wait for success message
  await expect(
    page.getByText(/email verified|verified successfully/i)
  ).toBeVisible({
    timeout: 10000,
  });
}

/**
 * Sign in with existing credentials (assumes already on login page)
 */
async function signIn(
  page: Page,
  credentials: { email: string; password: string }
): Promise<void> {
  await page.getByLabel(/email/i).fill(credentials.email);
  await page.getByLabel(/password/i).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Wait for dashboard
  await expect(page.getByText(/my todos/i)).toBeVisible({ timeout: 10000 });
}

/**
 * Sign up, verify email if needed, and then sign in (full authentication flow)
 */
async function signUpAndSignIn(
  page: Page,
  frontendUrl: string,
  credentials: { email: string; password: string }
): Promise<void> {
  const emailVerificationRequired = await signUp(
    page,
    frontendUrl,
    credentials
  );

  if (emailVerificationRequired) {
    // Verify email via MailDev before signing in
    await verifyEmailFromMailDev(page, frontendUrl, credentials.email);

    // Navigate back to login page
    await page.goto(frontendUrl);
  } else {
    // Go back to sign in - "Go to Sign In" button
    await page
      .getByRole('button', { name: /(go to|back to) sign in/i })
      .click();
  }

  // Sign in
  await signIn(page, credentials);
}

test.describe('Authentication Flow', () => {
  // Note: We don't delete emails in beforeEach because tests run in parallel
  // and would delete each other's verification emails. Each test uses a unique
  // email address via generateUniqueUser(), and waitForEmail() filters by recipient.

  test('should sign up a new user successfully', async ({
    page,
    frontendUrl,
    testUser,
  }) => {
    await signUp(page, frontendUrl, testUser);
  });

  test('should sign in and access dashboard', async ({
    page,
    frontendUrl,
    testUser,
  }) => {
    await signUpAndSignIn(page, frontendUrl, testUser);
  });

  test('should sign out successfully', async ({
    page,
    frontendUrl,
    testUser,
  }) => {
    // Sign up and sign in
    await signUpAndSignIn(page, frontendUrl, testUser);

    // Click sign out button
    await page.getByRole('button', { name: /logout/i }).click();

    // Should be back at login form
    await expect(
      page.getByRole('heading', { name: /sign in to todo app/i })
    ).toBeVisible({ timeout: 5000 });
  });

  test('should show error for invalid credentials', async ({
    page,
    frontendUrl,
    testUser,
  }) => {
    await page.goto(frontendUrl);

    // Try to sign in with credentials that don't exist
    await page.getByLabel(/email/i).fill(testUser.email);
    await page.getByLabel(/password/i).fill(testUser.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Should see an error message
    await expect(page.getByText(/login failed|invalid|error/i)).toBeVisible({
      timeout: 10000,
    });
  });
});
