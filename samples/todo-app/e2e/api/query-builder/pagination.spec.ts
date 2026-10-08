import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext } from './setup';

describe('Query Builder E2E - Pagination', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    for (let i = 0; i < 5; i += 1) {
      const todo = await createTodoWithNullableDescription(client, userId, {
        Title: `Paginated ${i}`,
        points: i + 1,
        createdAt: new Date(Date.now() + i * 1000),
        updatedAt: new Date(Date.now() + i * 1000),
      });
      createdIds.push(todo.id);
    }
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  it('supports forward pagination (first/after)', async () => {
    const firstPage = await client.data.Todo.select(['id', 'Title'])
      .orderBy({ createdAt: 'asc' })
      .first(2)
      .executePaginated();

    expect(firstPage.items).toHaveLength(2);
    // DAB only returns endCursor and hasNextPage (not startCursor or hasPreviousPage)
    expect(firstPage.endCursor).toBeDefined();
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.items[0].Title).toBe('Paginated 0');
    expect(firstPage.items[1].Title).toBe('Paginated 1');

    const secondPage = await client.data.Todo.select(['id', 'Title'])
      .orderBy({ createdAt: 'asc' })
      .first(2)
      .after(firstPage.endCursor ?? '')
      .executePaginated();

    expect(secondPage.items.length).toBeGreaterThan(0);
    expect(secondPage.endCursor).toBeDefined();
    expect(secondPage.hasNextPage).toBe(true);
    expect(secondPage.items[0].Title).toBe('Paginated 2');
    expect(secondPage.items[1].Title).toBe('Paginated 3');

    const lastPage = await client.data.Todo.select(['id', 'Title'])
      .orderBy({ createdAt: 'asc' })
      .first(2)
      .after(secondPage.endCursor ?? '')
      .executePaginated();
    expect(lastPage.items.length).toBe(1);
    expect(lastPage.items[0].Title).toBe('Paginated 4');
    expect(lastPage.endCursor).toBeUndefined();
    expect(lastPage.hasNextPage).toBe(false);
  });
});
