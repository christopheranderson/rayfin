/**
 * E2E test: FK Constraint Violation Error Sanitization
 *
 * Regression test for the issue where deleting a parent entity (Category) that
 * still has child records (Todos) returned a raw SQL Server error exposing:
 * - Internal database name (e.g. "stress-tracker-82bb814c-fec1-480c-afa4-...")
 * - Internal table names (e.g. "dbo.Todos")
 * - FK constraint names (e.g. "FK_Todos_category_id")
 *
 * After the fix, the API should return a sanitized user-friendly message like:
 * "Cannot complete this operation because other items depend on this record."
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
import {
  generateUniqueCategory,
  generateUniqueTodo,
  generateUniqueUser,
} from '../../shared/test-data';

describe('FK Constraint Violation Error Sanitization', () => {
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

  it('should return a sanitized error when deleting a category with child todos', async () => {
    const session = client.auth.getSession();
    const userId = session.user!.id;

    // Step 1: Create a parent Category
    const newCategory = generateUniqueCategory();
    const createdCategory = await client.data.Category.create({
      name: newCategory.name,
      color: newCategory.color,
      user_id: userId,
    });
    expect(createdCategory.id).toBeDefined();

    // Step 2: Create a child Todo linked to the Category via FK
    const newTodo = generateUniqueTodo();
    const timestamp = new Date();
    const createdTodo = await client.data.Todo.create({
      Title: newTodo.title,
      isCompleted: false,
      priority: 'medium',
      points: 5,
      percentComplete: 0.5,
      createdAt: timestamp,
      updatedAt: timestamp,
      user_id: userId,
      category: { id: createdCategory.id },
    });
    expect(createdTodo.id).toBeDefined();

    // Step 3: Attempt to delete the parent Category (should fail with FK violation)
    const deleteResult = await executeGraphQL(
      `mutation { deleteCategory(id: "${createdCategory.id}") { id } }`,
      accessToken
    );

    // Step 4: Verify the response has an error
    expect(deleteResult.errors).toBeDefined();
    expect(deleteResult.errors!.length).toBeGreaterThan(0);

    const errorMessage = deleteResult.errors![0].message;

    // Step 5: Verify the error message is sanitized — no internal details exposed
    // These are the raw SQL details that were previously leaked:
    expect(errorMessage).not.toContain('FK_');
    expect(errorMessage).not.toContain('dbo.');
    expect(errorMessage).not.toContain('REFERENCE constraint');
    expect(errorMessage).not.toContain('DELETE statement conflicted');
    expect(errorMessage).not.toContain('column');
    expect(errorMessage).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    ); // No GUIDs (database name)
    expect(errorMessage).not.toContain('The statement has been terminated');

    // Step 6: Verify the error message IS user-friendly
    expect(errorMessage).toContain(
      'Cannot complete this operation because other items depend on this record'
    );

    // Step 7: Verify error code is set correctly
    const errorCode = deleteResult.errors![0].extensions?.code;
    expect(errorCode).toBe('BadRequest');

    // Cleanup: delete child first, then parent
    await client.data.Todo.delete({ id: createdTodo.id });
    await client.data.Category.delete({ id: createdCategory.id });
  });

  it('should return a sanitized error when deleting via raw GraphQL mutation', async () => {
    const session = client.auth.getSession();
    const userId = session.user!.id;

    // Create parent and child using raw GraphQL to mirror the original bug report
    const createCategoryResult = await executeGraphQL(
      `mutation {
        createCategory(item: {
          name: "e2e-fk-test-category",
          color: "#ff0000",
          user_id: "${userId}"
        }) { id }
      }`,
      accessToken
    );
    expect(createCategoryResult.errors).toBeUndefined();
    const categoryId = (
      createCategoryResult.data?.createCategory as { id: string }
    ).id;

    const now = new Date().toISOString();
    const createTodoResult = await executeGraphQL(
      `mutation {
        createTodo(item: {
          Title: "e2e-fk-test-todo",
          isCompleted: false,
          priority: "medium",
          points: 1,
          percentComplete: 0.0,
          createdAt: "${now}",
          updatedAt: "${now}",
          user_id: "${userId}",
          category_id: "${categoryId}"
        }) { id }
      }`,
      accessToken
    );
    expect(createTodoResult.errors).toBeUndefined();
    const todoId = (createTodoResult.data?.createTodo as { id: string }).id;

    // Attempt to delete parent — this is the exact scenario from the bug report
    const deleteResult = await executeGraphQL(
      `mutation { deleteCategory(id: "${categoryId}") { id } }`,
      accessToken
    );

    // Verify error is returned and sanitized
    expect(deleteResult.errors).toBeDefined();
    const error = deleteResult.errors![0];

    // No raw SQL or internal details
    expect(error.message).not.toMatch(/database/i);
    expect(error.message).not.toMatch(/table/i);
    expect(error.message).not.toContain('FK_');
    expect(error.message).not.toContain('dbo.');
    expect(error.message).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    );

    // User-friendly message
    expect(error.message).toContain(
      'Cannot complete this operation because other items depend on this record'
    );

    // Cleanup
    await executeGraphQL(
      `mutation { deleteTodo(id: "${todoId}") { id } }`,
      accessToken
    );
    await executeGraphQL(
      `mutation { deleteCategory(id: "${categoryId}") { id } }`,
      accessToken
    );
  });

  it('should allow deleting a category after its child todos are removed', async () => {
    const session = client.auth.getSession();
    const userId = session.user!.id;

    // Create parent and child
    const newCategory = generateUniqueCategory();
    const createdCategory = await client.data.Category.create({
      name: newCategory.name,
      color: newCategory.color,
      user_id: userId,
    });

    const newTodo = generateUniqueTodo();
    const timestamp = new Date();
    const createdTodo = await client.data.Todo.create({
      Title: newTodo.title,
      isCompleted: false,
      priority: 'low',
      points: 1,
      percentComplete: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      user_id: userId,
      category: { id: createdCategory.id },
    });

    // Delete the child first
    await client.data.Todo.delete({ id: createdTodo.id });

    // Now deleting the parent should succeed
    const deleteResult = await executeGraphQL(
      `mutation { deleteCategory(id: "${createdCategory.id}") { id } }`,
      accessToken
    );

    expect(deleteResult.errors).toBeUndefined();
    expect((deleteResult.data?.deleteCategory as { id: string }).id).toBe(
      createdCategory.id
    );
  });
});
