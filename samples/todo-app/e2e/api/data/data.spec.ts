import type { RayfinClient } from '@microsoft/rayfin-client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';
import { startBackend, stopBackend } from '../../shared/backend';
import { createTestClient } from '../../shared/client-factory';
import {
  generateUniqueCategory,
  generateUniqueTodo,
  generateUniqueUser,
} from '../../shared/test-data';

describe('Data E2E Tests', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;

  beforeAll(async () => {
    await startBackend();

    client = createTestClient();
    const user = generateUniqueUser();

    await client.auth.signUp({ email: user.email, password: user.password });
    await client.auth.signIn({ email: user.email, password: user.password });
  });

  afterAll(async () => {
    await stopBackend();
  });

  it('creates, reads, and deletes a todo via the GraphQL client', async () => {
    const session = client.auth.getSession();
    expect(session.isAuthenticated).toBe(true);
    expect(session.user).toBeDefined();

    const newTodo = generateUniqueTodo();
    const timestamp = new Date();

    const createdTodo = await client.data.Todo.create({
      Title: newTodo.title,
      description: newTodo.description,
      isCompleted: false,
      priority: 'medium',
      points: 5,
      percentComplete: 0.25,
      createdAt: timestamp,
      updatedAt: timestamp,
      user_id: session.user!.id,
    });

    expect(createdTodo.id).toBeDefined();
    expect(createdTodo.Title).toBe(newTodo.title);
    expect(createdTodo.isCompleted).toBe(false);

    const queriedTodos = await client.data.Todo.select([
      'id',
      'Title',
      'description',
      'isCompleted',
    ])
      .where({ id: { eq: createdTodo.id } })
      .execute();

    expect(queriedTodos).toHaveLength(1);
    expect(queriedTodos[0].Title).toBe(newTodo.title);

    await client.data.Todo.delete({ id: createdTodo.id });

    const afterDeleteTodos = await client.data.Todo.select(['id'])
      .where({ id: { eq: createdTodo.id } })
      .execute();

    expect(afterDeleteTodos).toHaveLength(0);
  });

  it('queries a category with its todos via the @many navigation', async () => {
    const session = client.auth.getSession();
    expect(session.user).toBeDefined();
    const userId = session.user!.id;

    const newCategory = generateUniqueCategory();
    const createdCategory = await client.data.Category.create({
      name: newCategory.name,
      color: newCategory.color,
      user_id: userId,
    });

    expect(createdCategory.id).toBeDefined();

    const categoryReference = {
      id: createdCategory.id,
      name: createdCategory.name,
      color: createdCategory.color,
      user_id: createdCategory.user_id,
    };

    const timestamp = new Date();
    const todoTitles = ['First Todo', 'Second Todo', 'Third Todo'];
    const createdTodoIds: string[] = [];

    for (const title of todoTitles) {
      const todo = await client.data.Todo.create({
        Title: title,
        isCompleted: false,
        priority: 'medium',
        points: 1,
        percentComplete: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        user_id: userId,
        category: categoryReference,
      });

      createdTodoIds.push(todo.id);
    }

    const categories = await client.data.Category.select([
      'id',
      'name',
      'color',
      'todos.id',
      'todos.Title',
    ])
      .where({ id: { eq: createdCategory.id } })
      .execute();

    expect(categories).toHaveLength(1);
    const fetchedCategory = categories[0];
    expect(fetchedCategory.name).toBe(newCategory.name);
    const associatedTodos = fetchedCategory.todos ?? [];
    expect(associatedTodos).toHaveLength(todoTitles.length);

    const fetchedTitles = associatedTodos.map(
      (todo: { Title: string }) => todo.Title
    );
    for (const title of todoTitles) {
      expect(fetchedTitles).toContain(title);
    }

    for (const id of createdTodoIds) {
      await client.data.Todo.delete({ id });
    }

    await client.data.Category.delete({ id: createdCategory.id });
  });

  describe('Primary-Key-Only Relationship Input', () => {
    it('creates a todo with category using primary-key-only object', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;

      // Create a category first
      const newCategory = generateUniqueCategory();
      const createdCategory = await client.data.Category.create({
        name: newCategory.name,
        color: newCategory.color,
        user_id: userId,
      });

      expect(createdCategory.id).toBeDefined();

      // Create a todo using only the category's primary key (new ergonomic shorthand)
      const newTodo = generateUniqueTodo();
      const timestamp = new Date();

      const createdTodo = await client.data.Todo.create({
        Title: newTodo.title,
        description: newTodo.description,
        isCompleted: false,
        priority: 'low',
        points: 3,
        percentComplete: 0.5,
        createdAt: timestamp,
        updatedAt: timestamp,
        user_id: userId,
        category: { id: createdCategory.id }, // Primary-key-only!
      });

      expect(createdTodo.id).toBeDefined();
      expect(createdTodo.category?.id).toBe(createdCategory.id);

      // Verify the relationship by querying
      const queriedTodos = await client.data.Todo.select([
        'id',
        'Title',
        'category.id',
        'category.name',
      ])
        .where({ id: { eq: createdTodo.id } })
        .execute();

      expect(queriedTodos).toHaveLength(1);
      expect(queriedTodos[0].category?.id).toBe(createdCategory.id);
      expect(queriedTodos[0].category?.name).toBe(newCategory.name);

      // Cleanup
      await client.data.Todo.delete({ id: createdTodo.id });
      await client.data.Category.delete({ id: createdCategory.id });
    });

    it('updates a todo category using primary-key-only object', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;

      // Create two categories
      const category1 = generateUniqueCategory();
      const category2 = generateUniqueCategory();

      const createdCategory1 = await client.data.Category.create({
        name: category1.name,
        color: category1.color,
        user_id: userId,
      });

      const createdCategory2 = await client.data.Category.create({
        name: category2.name,
        color: category2.color,
        user_id: userId,
      });

      // Create a todo with the first category
      const newTodo = generateUniqueTodo();
      const timestamp = new Date();

      const createdTodo = await client.data.Todo.create({
        Title: newTodo.title,
        isCompleted: false,
        priority: 'medium',
        points: 1,
        percentComplete: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        user_id: userId,
        category: { id: createdCategory1.id },
      });

      expect(createdTodo.category?.id).toBe(createdCategory1.id);

      // Update the todo to use the second category using primary-key-only
      const updatedTodo = await client.data.Todo.update(
        { id: createdTodo.id },
        {
          category: { id: createdCategory2.id }, // Primary-key-only!
        }
      );

      expect(updatedTodo.category?.id).toBe(createdCategory2.id);

      // Verify by querying
      const queriedTodos = await client.data.Todo.select([
        'id',
        'category.id',
        'category.name',
      ])
        .where({ id: { eq: createdTodo.id } })
        .execute();

      expect(queriedTodos).toHaveLength(1);
      expect(queriedTodos[0].category?.id).toBe(createdCategory2.id);
      expect(queriedTodos[0].category?.name).toBe(category2.name);

      // Cleanup
      await client.data.Todo.delete({ id: createdTodo.id });
      await client.data.Category.delete({ id: createdCategory1.id });
      await client.data.Category.delete({ id: createdCategory2.id });
    });

    it('creates multiple todos with same category using primary-key-only', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;

      // Create a category
      const newCategory = generateUniqueCategory();
      const createdCategory = await client.data.Category.create({
        name: newCategory.name,
        color: newCategory.color,
        user_id: userId,
      });

      // Create multiple todos all referencing the category by ID only
      const timestamp = new Date();
      const todoIds: string[] = [];

      for (let i = 0; i < 3; i++) {
        const todo = await client.data.Todo.create({
          Title: `Primary-Key Test Todo ${i + 1}`,
          isCompleted: false,
          priority: 'high',
          points: i + 1,
          percentComplete: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          user_id: userId,
          category: { id: createdCategory.id }, // Primary-key-only for all
        });

        todoIds.push(todo.id);
        expect(todo.category?.id).toBe(createdCategory.id);
      }

      // Verify all todos are associated with the category
      const categoryWithTodos = await client.data.Category.select([
        'id',
        'name',
        'todos.id',
        'todos.Title',
      ])
        .where({ id: { eq: createdCategory.id } })
        .execute();

      expect(categoryWithTodos).toHaveLength(1);
      expect(categoryWithTodos[0].todos).toHaveLength(3);

      // Cleanup
      for (const id of todoIds) {
        await client.data.Todo.delete({ id });
      }
      await client.data.Category.delete({ id: createdCategory.id });
    });

    it('removes a deleted todo from the category relationship', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;

      // Create a category
      const newCategory = generateUniqueCategory();
      const createdCategory = await client.data.Category.create({
        name: newCategory.name,
        color: newCategory.color,
        user_id: userId,
      });

      // Create three todos referencing the category by ID only
      const timestamp = new Date();
      const todoIds: string[] = [];

      for (let i = 0; i < 3; i++) {
        const todo = await client.data.Todo.create({
          Title: `Deletion Test Todo ${i + 1}`,
          isCompleted: false,
          priority: 'medium',
          points: 1,
          percentComplete: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          user_id: userId,
          category: { id: createdCategory.id },
        });

        todoIds.push(todo.id);
      }

      // Verify all three todos are associated
      const beforeDelete = await client.data.Category.select([
        'id',
        'todos.id',
        'todos.Title',
      ])
        .where({ id: { eq: createdCategory.id } })
        .execute();

      expect(beforeDelete).toHaveLength(1);
      expect(beforeDelete[0].todos).toHaveLength(3);

      // Delete the second todo
      const deletedTodoId = todoIds[1];
      await client.data.Todo.delete({ id: deletedTodoId });

      // Query the category again — deleted todo should be gone
      const afterDelete = await client.data.Category.select([
        'id',
        'todos.id',
        'todos.Title',
      ])
        .where({ id: { eq: createdCategory.id } })
        .execute();

      expect(afterDelete).toHaveLength(1);
      const remainingTodos = afterDelete[0].todos ?? [];
      expect(remainingTodos).toHaveLength(2);

      const remainingIds = remainingTodos.map(
        (todo: { id: string }) => todo.id
      );
      expect(remainingIds).not.toContain(deletedTodoId);
      expect(remainingIds).toContain(todoIds[0]);
      expect(remainingIds).toContain(todoIds[2]);

      // Cleanup
      for (const id of todoIds.filter((i) => i !== deletedTodoId)) {
        await client.data.Todo.delete({ id });
      }
      await client.data.Category.delete({ id: createdCategory.id });
    });
  });

  describe('GraphQL Error Propagation', () => {
    it('surfaces actual error messages instead of generic "Unexpected Execution Error"', async () => {
      const session = client.auth.getSession();
      expect(session.isAuthenticated).toBe(true);

      // Try to create a todo with an invalid user_id (foreign key constraint)
      // This should return an actual error message, not "Unexpected Execution Error"
      const timestamp = new Date();

      try {
        await client.data.Todo.create({
          Title: 'Test Todo',
          description: 'Test description',
          isCompleted: false,
          priority: 'medium',
          points: 5,
          percentComplete: 0.25,
          createdAt: timestamp,
          updatedAt: timestamp,
          user_id: '00000000-0000-0000-0000-000000000000', // Non-existent user ID
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: unknown) {
        // Verify we get an actual error message, not the generic one
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // The error should contain actual details about the failure
        // It should NOT just say "Unexpected Execution Error"
        expect(errorMessage).not.toBe('Unexpected Execution Error');

        // Log the error for debugging visibility
        console.log('Received error message:', errorMessage);
      }
    });
  });

  describe('ID Generation and Handling', () => {
    /** Standard UUID v4 format regex */
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it('auto-generates a valid UUID when no id is supplied', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;
      const timestamp = new Date();

      const todo = await client.data.Todo.create({
        Title: 'Auto-ID Todo',
        isCompleted: false,
        priority: 'medium',
        points: 1,
        percentComplete: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        user_id: userId,
      });

      expect(todo.id).toBeDefined();
      expect(todo.id).toMatch(UUID_REGEX);

      // Cleanup
      await client.data.Todo.delete({ id: todo.id });
    });

    it('preserves a user-supplied id on create', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;
      const timestamp = new Date();

      const suppliedId = crypto.randomUUID();

      const todo = await client.data.Todo.create({
        id: suppliedId,
        Title: 'Explicit-ID Todo',
        isCompleted: false,
        priority: 'low',
        points: 2,
        percentComplete: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        user_id: userId,
      });

      expect(todo.id).toBe(suppliedId);

      // Verify the record is queryable by the supplied id
      const fetched = await client.data.Todo.select(['id', 'Title'])
        .where({ id: { eq: suppliedId } })
        .execute();

      expect(fetched).toHaveLength(1);
      expect(fetched[0].id).toBe(suppliedId);
      expect(fetched[0].Title).toBe('Explicit-ID Todo');

      // Cleanup
      await client.data.Todo.delete({ id: suppliedId });
    });

    it('rejects creation with a duplicate id', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;
      const timestamp = new Date();

      const suppliedId = crypto.randomUUID();

      // First create should succeed
      const todo = await client.data.Todo.create({
        id: suppliedId,
        Title: 'Duplicate-ID First',
        isCompleted: false,
        priority: 'medium',
        points: 1,
        percentComplete: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        user_id: userId,
      });

      expect(todo.id).toBe(suppliedId);

      // Second create with the same id should fail
      try {
        await client.data.Todo.create({
          id: suppliedId,
          Title: 'Duplicate-ID Second',
          isCompleted: false,
          priority: 'medium',
          points: 1,
          percentComplete: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          user_id: userId,
        });
        expect.fail('Expected duplicate id creation to throw');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // Should get a conflict / primary key violation, not a generic error
        expect(message).toBeTruthy();
      }

      // Cleanup
      await client.data.Todo.delete({ id: suppliedId });
    });

    it('auto-generates a valid UUID for a category (different entity)', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;

      const category = await client.data.Category.create({
        name: 'UUID Test Category',
        color: '#abcdef',
        user_id: userId,
      });

      expect(category.id).toBeDefined();
      expect(category.id).toMatch(UUID_REGEX);

      // Cleanup
      await client.data.Category.delete({ id: category.id });
    });
  });

  describe('Default Value Behavior', () => {
    it('applies the database default when a nullable field with default is omitted', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;
      const timestamp = new Date();

      // Create a todo WITHOUT providing `points` — the DB default (2) should be applied
      const todo = await client.data.Todo.create({
        Title: 'Default Points Todo',
        isCompleted: false,
        priority: 'medium',
        percentComplete: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        user_id: userId,
      });

      expect(todo.id).toBeDefined();

      // Query back to verify the stored value
      const fetched = await client.data.Todo.select(['id', 'points'])
        .where({ id: { eq: todo.id } })
        .execute();

      expect(fetched).toHaveLength(1);
      expect(fetched[0].points).toBe(2); // DB DEFAULT 2

      // Cleanup
      await client.data.Todo.delete({ id: todo.id });
    });

    it('uses the explicit value when provided for a field with default', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;
      const timestamp = new Date();

      const todo = await client.data.Todo.create({
        Title: 'Explicit Points Todo',
        isCompleted: false,
        priority: 'high',
        points: 99,
        percentComplete: 0.5,
        createdAt: timestamp,
        updatedAt: timestamp,
        user_id: userId,
      });

      expect(todo.id).toBeDefined();

      const fetched = await client.data.Todo.select(['id', 'points'])
        .where({ id: { eq: todo.id } })
        .execute();

      expect(fetched).toHaveLength(1);
      expect(fetched[0].points).toBe(99);

      // Cleanup
      await client.data.Todo.delete({ id: todo.id });
    });

    it('rejects null for a non-nullable field with default', async () => {
      const session = client.auth.getSession();
      expect(session.user).toBeDefined();
      const userId = session.user!.id;
      const timestamp = new Date();

      // Explicitly pass null for a NOT NULL column — should be rejected by the database.
      // Under DAB 2.0.10 the underlying not-null/type violation is sanitized to a
      // generic "Internal server error" by the error-sanitization layer before it
      // reaches the client (unlike 2.1.0-rc, which surfaces the raw datatype mismatch).
      await expect(
        client.data.Todo.create({
          Title: 'Null Points Todo',
          isCompleted: false,
          priority: 'low',
          points: null as unknown as number,
          percentComplete: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          user_id: userId,
        })
      ).rejects.toThrow(/Internal server error/);
    });
  });
});
