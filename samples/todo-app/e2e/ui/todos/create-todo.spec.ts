import { waitForEmail, extractTokenFromEmail } from '../../shared/maildev';
import { generateUniqueTodo } from '../../shared/test-data';
import { test, expect } from '../fixtures';

test.describe('Todo CRUD Operations', () => {
  // Note: We don't delete emails in beforeEach because tests run in parallel
  // and would delete each other's verification emails. Each test uses a unique
  // email address via generateUniqueUser(), and waitForEmail() filters by recipient.

  // Helper to sign up and sign in before each test
  // Handles email verification when required
  async function signUpAndSignIn(
    page: import('@playwright/test').Page,
    frontendUrl: string,
    testUser: { email: string; password: string }
  ) {
    await page.goto(frontendUrl);

    // Switch to signup
    await page
      .getByRole('button', { name: /need an account\? sign up/i })
      .click();

    // Fill signup form
    await page.getByLabel(/email/i).fill(testUser.email);
    await page.getByLabel(/^password$/i).fill(testUser.password);
    await page.getByLabel(/confirm password/i).fill(testUser.password);
    await page.getByRole('button', { name: /sign up/i }).click();

    // Wait for success - handles both email verification enabled and disabled
    // "Account Created Successfully!" when email verification is disabled
    // "Account Created!" when email verification is enabled
    await expect(
      page.getByRole('heading', { name: /account created/i })
    ).toBeVisible({ timeout: 10000 });

    // Check if email verification is required (shows "Back to Sign In" vs "Go to Sign In")
    const backToSignInButton = page.getByRole('button', {
      name: /back to sign in/i,
    });
    const emailVerificationRequired = await backToSignInButton
      .isVisible()
      .catch(() => false);

    if (emailVerificationRequired) {
      // Verify email via MailDev before signing in
      const verificationEmail = await waitForEmail(testUser.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });
      const token = extractTokenFromEmail(verificationEmail);
      await page.goto(`${frontendUrl}/verify-email?token=${token}`);
      await expect(
        page.getByText(/email verified|verified successfully/i)
      ).toBeVisible({ timeout: 10000 });

      // Navigate back to login page
      await page.goto(frontendUrl);
    } else {
      // Go back to sign in - "Go to Sign In" button
      await page
        .getByRole('button', { name: /(go to|back to) sign in/i })
        .click();
    }

    // Sign in
    await page.getByLabel(/email/i).fill(testUser.email);
    await page.getByLabel(/password/i).fill(testUser.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Wait for dashboard
    await expect(page.getByText(/my todos/i)).toBeVisible({ timeout: 10000 });
  }

  test('should create a new todo', async ({ page, frontendUrl, testUser }) => {
    await signUpAndSignIn(page, frontendUrl, testUser);

    const todo = generateUniqueTodo();

    // Click add todo button
    await page.getByRole('button', { name: /add todo/i }).click();

    // Fill in the todo form
    await page.getByLabel(/title/i).fill(todo.title);
    await page.getByLabel(/description/i).fill(todo.description || '');

    // Submit the form
    await page
      .locator('form')
      .getByRole('button', { name: 'Add Todo' })
      .click();

    // Verify the todo appears in the list
    await expect(page.getByText(todo.title)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(todo.description || '')).toBeVisible({
      timeout: 5000,
    });
  });

  test('should mark a todo as complete', async ({
    page,
    frontendUrl,
    testUser,
  }) => {
    await signUpAndSignIn(page, frontendUrl, testUser);

    const todo = generateUniqueTodo();

    // Create a todo first
    await page.getByRole('button', { name: /add todo/i }).click();
    await page.getByLabel(/title/i).fill(todo.title);
    await page
      .locator('form')
      .getByRole('button', { name: 'Add Todo' })
      .click();

    // Wait for todo to appear
    await expect(page.getByText(todo.title)).toBeVisible({ timeout: 5000 });

    // Find the checkbox for this todo and click it
    const todoItem = page
      .locator('div')
      .filter({ hasText: todo.title })
      .first();
    const checkbox = todoItem.getByRole('checkbox');
    await checkbox.click();

    // Verify the todo is marked as complete (has line-through style)
    await expect(todoItem.locator('.line-through')).toBeVisible({
      timeout: 5000,
    });
  });

  test('should delete a todo', async ({ page, frontendUrl, testUser }) => {
    await signUpAndSignIn(page, frontendUrl, testUser);

    const todo = generateUniqueTodo();

    // Create a todo first
    await page.getByRole('button', { name: /add todo/i }).click();
    await page.getByLabel(/title/i).fill(todo.title);
    await page
      .locator('form')
      .getByRole('button', { name: 'Add Todo' })
      .click();

    // Wait for todo to appear
    await expect(page.getByText(todo.title)).toBeVisible({ timeout: 5000 });

    // Find and click the delete button for this todo
    const todoItem = page
      .locator('div')
      .filter({ hasText: todo.title })
      .first();
    await todoItem.getByRole('button', { name: /delete/i }).click();

    // Verify the todo is removed
    await expect(page.getByText(todo.title)).not.toBeVisible({ timeout: 5000 });
  });
});
