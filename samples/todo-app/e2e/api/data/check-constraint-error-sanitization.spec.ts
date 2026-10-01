/**
 * E2E test: Check Constraint Violation Error Sanitization
 *
 * Verifies that inserting a value violating a SQL CHECK constraint
 * (e.g. an invalid `@set` value) returns a sanitized user-friendly message
 * instead of raw database error that may expose internal table/constraint names.
 *
 * Architecture note:
 * - `@set('low','medium','high')` creates a SQL CHECK constraint on the column.
 * - When an invalid value is sent via GraphQL, it bypasses HC enum validation
 *   (DAB maps `@set` to a string column) and reaches the database.
 * - SQL Server rejects it with error 547 (CHECK constraint violation).
 * - GetSanitizedDatabaseErrorMessage detects error 547 + "CHECK constraint"
 *   in the message and returns a user-friendly message.
 */
import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';
import { startBackend, stopBackend } from '../../shared/backend';
import { createTestClient } from '../../shared/client-factory';
import { executeGraphQL } from '../../shared/graphql';
import {
  extractTokenFromEmail,
  isMailDevAvailable,
  waitForEmail,
} from '../../shared/maildev';
import { generateUniqueUser } from '../../shared/test-data';

describe('Check Constraint Violation Error Sanitization', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let accessToken: string;

  beforeAll(async () => {
    await startBackend();

    client = createTestClient();
    const user = generateUniqueUser();

    await client.auth.signUp({ email: user.email, password: user.password });

    // Verify email via MailDev if email verification is enabled
    const emailEnabled = await isMailDevAvailable();
    if (emailEnabled) {
      const verificationEmail = await waitForEmail(user.email, {
        subjectContains: 'verify',
        timeoutMs: 30_000,
      });
      const token = extractTokenFromEmail(verificationEmail);
      await client.auth.verifyEmail(token);
    }

    await client.auth.signIn({ email: user.email, password: user.password });
    accessToken = (client.auth as unknown as { accessToken: string })
      .accessToken;
  });

  afterAll(async () => {
    await stopBackend();
  });

  it('should return a sanitized error when inserting an invalid @set value', async () => {
    const session = client.auth.getSession();
    const userId = session.user!.id;
    const now = new Date().toISOString();

    // Todo.priority is @set('low', 'medium', 'high') — 'bad' is not a valid value.
    // DAB maps @set to a string column, so this bypasses HC enum validation and
    // reaches the database where the CHECK constraint (CK_Todos_priority) rejects it.
    // SQL Server returns error 547 (CHECK constraint violation), which the sanitizer
    // maps to a user-friendly message.
    const result = await executeGraphQL(
      `mutation {
        createTodo(item: {
          Title: "check-constraint-test",
          isCompleted: false,
          priority: "bad",
          points: 1,
          percentComplete: 0.0,
          createdAt: "${now}",
          updatedAt: "${now}",
          user_id: "${userId}"
        }) { id }
      }`,
      accessToken
    );

    // Step 1: Verify the response has an error
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);

    const errorMessage = result.errors![0].message;

    // Step 2: Verify no raw database internals are leaked
    expect(errorMessage).not.toMatch(/violates check constraint/i);
    expect(errorMessage).not.toContain('CK_');
    expect(errorMessage).not.toContain('dbo.');
    expect(errorMessage).not.toMatch(/constraint "[^"]+"/);
    expect(errorMessage).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    ); // No GUIDs

    // Step 3: Verify the error message IS user-friendly
    expect(errorMessage).toBe(
      'The value provided does not meet the required constraints.'
    );

    // Step 4: Verify error code is set correctly
    const errorCode = result.errors![0].extensions?.code;
    expect(errorCode).toBe('BadRequest');
  });

  it('should accept valid @set values after rejecting invalid ones', async () => {
    const session = client.auth.getSession();
    const userId = session.user!.id;
    const now = new Date().toISOString();

    // Valid priority value should succeed
    const result = await executeGraphQL(
      `mutation {
        createTodo(item: {
          Title: "check-constraint-valid",
          isCompleted: false,
          priority: "high",
          points: 1,
          percentComplete: 0.0,
          createdAt: "${now}",
          updatedAt: "${now}",
          user_id: "${userId}"
        }) { id priority }
      }`,
      accessToken
    );

    expect(result.errors).toBeUndefined();
    const created = result.data?.createTodo as {
      id: string;
      priority: string;
    };
    expect(created.priority).toBe('high');

    // Cleanup
    await executeGraphQL(
      `mutation { deleteTodo(id: "${created.id}") { id } }`,
      accessToken
    );
  });
});
