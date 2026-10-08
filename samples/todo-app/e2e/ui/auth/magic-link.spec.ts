import type { Page } from '@playwright/test';

import {
  isMailDevAvailable,
  waitForEmail,
  extractMagicLinkFromEmail,
} from '../../shared/maildev';
import { generateUniqueUser } from '../../shared/test-data';
import { test, expect } from '../fixtures';

/**
 * Helper to navigate to magic link sign-in form
 */
async function goToMagicLinkForm(
  page: Page,
  frontendUrl: string
): Promise<void> {
  await page.goto(frontendUrl);

  // Click "Sign in with magic link" button
  await page.getByRole('button', { name: /sign in with magic link/i }).click();

  // Verify we're on the magic link form
  await expect(
    page.getByRole('heading', { name: /sign in with email/i })
  ).toBeVisible({ timeout: 5000 });
}

/**
 * Helper to submit magic link form and wait for success
 * Throws with helpful error message if form shows an error instead
 * Captures console errors and network failures for debugging in CI
 */
async function submitMagicLinkFormAndWaitForSuccess(
  page: Page,
  email: string
): Promise<void> {
  // Capture console errors for debugging
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Capture network failures on the magic link API endpoint
  const networkErrors: string[] = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/auth/') && !response.ok()) {
      try {
        const body = await response.text();
        networkErrors.push(
          `${response.status()} ${response.statusText()} - ${url}\nBody: ${body.substring(0, 500)}`
        );
      } catch {
        networkErrors.push(
          `${response.status()} ${response.statusText()} - ${url}`
        );
      }
    }
  });

  await page.getByLabel(/email/i).fill(email);
  const submitButton = page.getByRole('button', { name: /send magic link/i });
  await submitButton.click();

  // Wait for either success heading OR error message
  // Note: We don't check for loading state as it may be too brief to catch
  const successHeading = page.getByRole('heading', {
    name: /check your email/i,
  });
  const errorBanner = page.locator('.bg-red-50');

  // Race: wait for whichever appears first (30s timeout for slow CI)
  await Promise.race([
    successHeading.waitFor({ state: 'visible', timeout: 30000 }),
    errorBanner.waitFor({ state: 'visible', timeout: 30000 }),
  ]);

  // Check if we got an error instead of success
  if (await errorBanner.isVisible()) {
    const errorText = await errorBanner.textContent();
    // Include console and network errors for debugging
    const consoleDebug =
      consoleErrors.length > 0
        ? `\n\nConsole errors:\n${consoleErrors.join('\n')}`
        : '';
    const networkDebug =
      networkErrors.length > 0
        ? `\n\nNetwork errors:\n${networkErrors.join('\n---\n')}`
        : '';
    throw new Error(
      `Magic link form showed error: "${errorText}"${consoleDebug}${networkDebug}`
    );
  }

  // Verify success heading is visible
  await expect(successHeading).toBeVisible();
}

test.describe('Magic Link Authentication Flow', () => {
  // Check if email is enabled before tests
  let emailEnabled = false;

  test.beforeAll(async () => {
    emailEnabled = await isMailDevAvailable();
    if (!emailEnabled) {
      console.log(
        '⚠️ MailDev not available - magic link UI tests will be skipped'
      );
    }
  });

  // Note: We don't delete emails in beforeEach because tests run in parallel
  // and would delete each other's verification emails. Each test uses a unique
  // email address via generateUniqueUser(), and waitForEmail() filters by recipient.

  test('should show magic link sign-in option', async ({
    page,
    frontendUrl,
  }) => {
    await page.goto(frontendUrl);

    // Verify magic link button is present (in development mode)
    const magicLinkButton = page.getByRole('button', {
      name: /sign in with magic link/i,
    });
    await expect(magicLinkButton).toBeVisible({ timeout: 5000 });
  });

  test('should navigate to magic link form', async ({ page, frontendUrl }) => {
    await goToMagicLinkForm(page, frontendUrl);

    // Verify form elements are present
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(
      page.getByRole('button', { name: /send magic link/i })
    ).toBeVisible();
    await expect(page.getByText(/we'll send you a magic link/i)).toBeVisible();
  });

  test('should send magic link and show success message', async ({
    page,
    frontendUrl,
  }) => {
    test.skip(!emailEnabled, 'MailDev not available');

    const user = generateUniqueUser();

    await goToMagicLinkForm(page, frontendUrl);
    await submitMagicLinkFormAndWaitForSuccess(page, user.email);

    // Verify email is displayed
    await expect(page.getByText(user.email)).toBeVisible();

    // Verify email was actually sent
    const magicLinkEmail = await waitForEmail(user.email, {
      subjectContains: 'sign in',
      timeoutMs: 30_000,
    });
    expect(magicLinkEmail).toBeDefined();
  });

  test('should allow trying a different email from success screen', async ({
    page,
    frontendUrl,
  }) => {
    test.skip(!emailEnabled, 'MailDev not available');

    const user = generateUniqueUser();

    await goToMagicLinkForm(page, frontendUrl);
    await submitMagicLinkFormAndWaitForSuccess(page, user.email);

    // Click "Try a different email"
    await page.getByRole('button', { name: /try a different email/i }).click();

    // Should be back on the form with empty email
    await expect(
      page.getByRole('heading', { name: /sign in with email/i })
    ).toBeVisible();
    await expect(page.getByLabel(/email/i)).toHaveValue('');
  });

  test('should complete magic link authentication flow', async ({
    page,
    frontendUrl,
  }) => {
    test.skip(!emailEnabled, 'MailDev not available');

    const user = generateUniqueUser();

    // Step 1: Go to magic link form and submit
    await goToMagicLinkForm(page, frontendUrl);
    await submitMagicLinkFormAndWaitForSuccess(page, user.email);

    // Step 3: Get the magic link from the email
    const magicLinkEmail = await waitForEmail(user.email, {
      subjectContains: 'sign in',
      timeoutMs: 30_000,
    });

    const { fullUrl } = extractMagicLinkFromEmail(magicLinkEmail);

    // Step 4: Navigate to the magic link callback URL
    // The callback page will handle PKCE verification and authentication
    await page.goto(fullUrl);

    // Step 5: Wait for authentication to complete and redirect to dashboard
    // The callback page shows a loading state, then redirects to home
    await expect(page.getByText(/my todos/i)).toBeVisible({ timeout: 15000 });
  });

  test('should show error for invalid magic link callback', async ({
    page,
    frontendUrl,
  }) => {
    // Navigate directly to callback with invalid parameters
    await page.goto(
      `${frontendUrl}/auth/callback?verification_code=invalid&state=invalid`
    );

    // Should show error message
    await expect(
      page.getByText(/invalid|expired|error|not found/i)
    ).toBeVisible({ timeout: 10000 });
  });

  test('should go back to sign in options from magic link form', async ({
    page,
    frontendUrl,
  }) => {
    await goToMagicLinkForm(page, frontendUrl);

    // Click "Back to sign in options"
    await page
      .getByRole('button', { name: /back to sign in options/i })
      .click();

    // Should be back at main sign in page
    await expect(
      page.getByRole('heading', { name: /sign in to todo app/i })
    ).toBeVisible({ timeout: 5000 });
  });

  test('should validate email format before submission', async ({
    page,
    frontendUrl,
  }) => {
    await goToMagicLinkForm(page, frontendUrl);

    // Try to submit with invalid email
    await page.getByLabel(/email/i).fill('not-an-email');
    await page.getByRole('button', { name: /send magic link/i }).click();

    // Browser validation should prevent submission
    // The form should still be visible (not navigated away)
    await expect(
      page.getByRole('heading', { name: /sign in with email/i })
    ).toBeVisible();
  });
});
