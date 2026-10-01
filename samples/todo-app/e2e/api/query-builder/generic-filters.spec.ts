import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import {
  createCategory,
  createTodoWithNullableDescription,
  deleteCategory,
  deleteTodos,
} from './fixtures';
import { createQueryBuilderTestContext } from './setup';

describe('Query Builder E2E - Generic Filters', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  let categoryId: string | undefined;
  const createdIds: string[] = [];

  const categoryTitle = 'Generic Category Todo';
  const noCategoryTitle = 'Generic No Category';

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    const category = await createCategory(client, userId);
    categoryId = category.id;

    const todoWithCategory = await createTodoWithNullableDescription(
      client,
      userId,
      {
        Title: categoryTitle,
        points: 1,
        category_id: categoryId,
      }
    );

    const todoWithoutCategory = await createTodoWithNullableDescription(
      client,
      userId,
      {
        Title: noCategoryTitle,
        points: 2,
      }
    );

    createdIds.push(todoWithCategory.id, todoWithoutCategory.id);
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await deleteCategory(client, categoryId);
    await cleanup();
  });

  it('supports eq for object filters', async () => {
    const results = await client.data.Todo.select([
      'id',
      'Title',
      'category.id',
    ])
      .where({
        and: [
          {
            or: [
              { Title: { eq: categoryTitle } },
              { Title: { eq: noCategoryTitle } },
            ],
          },
          { category: { id: { eq: categoryId } } },
        ],
      })
      .execute();

    expect(results).toHaveLength(1);
    expect(results[0].Title).toBe(categoryTitle);
    expect(results[0].category?.id).toBe(categoryId);
  });

  it('supports neq for object filters', async () => {
    const results = await client.data.Todo.select([
      'id',
      'Title',
      'category.id',
    ])
      .where({
        and: [
          {
            or: [
              { Title: { eq: categoryTitle } },
              { Title: { eq: noCategoryTitle } },
            ],
          },
          { category: { id: { neq: crypto.randomUUID() } } },
        ],
      })
      .execute();

    expect(results).toHaveLength(1);
    expect(results[0].Title).toBe(categoryTitle);
    expect(results[0].category?.id).toBe(categoryId);
  });
});
