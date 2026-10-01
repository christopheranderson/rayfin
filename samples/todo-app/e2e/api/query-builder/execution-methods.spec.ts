import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext } from './setup';

describe('Query Builder E2E - Execution Methods', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    const todo = await createTodoWithNullableDescription(client, userId, {
      Title: 'Execution Todo',
      points: 7,
      percentComplete: 0.25,
    });
    createdIds.push(todo.id);
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  it('execute returns items', async () => {
    const results = await client.data.Todo.select(['id', 'Title'])
      .where({ Title: { contains: 'Execution' } })
      .execute();

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].Title).toContain('Execution');
  });

  it.skip('executePaginated returns page info and items', async () => {
    const paged = await client.data.Todo.select(['id', 'Title'])
      .first(1)
      .executePaginated();

    expect(paged.items).toHaveLength(1);
    expect(paged.hasNextPage).toBeDefined();
    expect(paged.endCursor).toBeDefined();
  });

  it.skip('count returns totalCount', async () => {
    const count = await client.data.Todo.where({
      Title: { contains: 'Execution' },
    }).count();

    expect(count).toBeGreaterThan(0);
  });
});
