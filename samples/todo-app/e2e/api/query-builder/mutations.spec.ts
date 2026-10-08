import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext } from './setup';

describe('Query Builder E2E - Mutations', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  it('creates and updates a todo', async () => {
    const todo = await createTodoWithNullableDescription(client, userId, {
      Title: 'Mutation Todo',
      points: 2,
      percentComplete: 0.5,
    });

    createdIds.push(todo.id);

    const updated = await client.data.Todo.update(
      { id: todo.id },
      { Title: 'Mutation Todo Updated', isCompleted: true }
    );

    expect(updated.Title).toBe('Mutation Todo Updated');
    expect(updated.isCompleted).toBe(true);

    const fetched = await client.data.Todo.select([
      'id',
      'Title',
      'isCompleted',
    ])
      .where({ id: { eq: todo.id } })
      .execute();

    expect(fetched).toHaveLength(1);
    expect(fetched[0].Title).toBe('Mutation Todo Updated');
    expect(fetched[0].isCompleted).toBe(true);
  });

  it('upserts a todo when missing, then updates on subsequent call', async () => {
    const createResult = await client.data.Todo.upsert(
      { id: crypto.randomUUID() },
      {
        Title: 'Upsert Created',
        isCompleted: false,
        priority: 'low',
        points: 1,
        percentComplete: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        user_id: userId,
      },
      {
        Title: 'Upsert Updated',
        isCompleted: true,
      }
    );

    createdIds.push(createResult.id);
    expect(createResult.Title).toBe('Upsert Created');

    const updateResult = await client.data.Todo.upsert(
      { id: createResult.id },
      {
        Title: 'Upsert Created',
        isCompleted: false,
        priority: 'low',
        points: 1,
        percentComplete: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        user_id: userId,
      },
      {
        Title: 'Upsert Updated',
        isCompleted: true,
      }
    );

    expect(updateResult.Title).toBe('Upsert Updated');
  });

  it('deletes a todo', async () => {
    const todo = await createTodoWithNullableDescription(client, userId, {
      Title: 'Delete Todo',
      points: 3,
    });

    const todo2 = await createTodoWithNullableDescription(client, userId, {
      Title: 'Not Deleted Todo',
      points: 3,
    });

    await client.data.Todo.delete({ id: todo.id });

    const afterDelete = await client.data.Todo.select(['id'])
      .where({ id: { eq: todo.id } })
      .execute();

    expect(afterDelete).toHaveLength(0);

    const nonDeletedAfterDelete = await client.data.Todo.select(['id'])
      .where({ id: { neq: todo.id } })
      .execute();

    expect(nonDeletedAfterDelete.length).toBeGreaterThan(0);
    expect(nonDeletedAfterDelete.some((t) => t.id === todo2.id)).toBe(true);

    // Cleanup
    createdIds.push(todo2.id);
  });
});
