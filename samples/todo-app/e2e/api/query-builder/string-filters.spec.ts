import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext } from './setup';

describe('Query Builder E2E - String Filters', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    const todoA = await createTodoWithNullableDescription(client, userId, {
      Title: 'Alpha urgent',
      description: 'contains secret',
    });
    const todoB = await createTodoWithNullableDescription(client, userId, {
      Title: 'Beta start',
      description: 'prefix check',
    });
    const todoC = await createTodoWithNullableDescription(client, userId, {
      Title: 'Gamma end',
      description: 'suffix check',
    });
    const todoNull = await createTodoWithNullableDescription(client, userId, {
      Title: 'Null Description',
      description: undefined,
    });

    createdIds.push(todoA.id, todoB.id, todoC.id, todoNull.id);
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  it('supports contains', async () => {
    const contains = await client.data.Todo.select(['id', 'Title'])
      .where({ Title: { contains: 'urgent' } })
      .execute();

    expect(contains.some((todo) => todo.Title.includes('urgent'))).toBe(true);
    expect(contains.length).toBe(1);
  });

  it('supports notContains', async () => {
    const notContains = await client.data.Todo.select(['id', 'Title'])
      .where({ Title: { notContains: 'urgent' } })
      .execute();

    expect(notContains.every((todo) => !todo.Title.includes('urgent'))).toBe(
      true
    );
    expect(notContains.length).toBe(3);
  });

  it('supports startsWith', async () => {
    const starts = await client.data.Todo.select(['id', 'Title'])
      .where({ Title: { startsWith: 'Beta' } })
      .execute();

    expect(starts.every((todo) => todo.Title.startsWith('Beta'))).toBe(true);
    expect(starts.length).toBe(1);
  });

  it('supports endsWith', async () => {
    const ends = await client.data.Todo.select(['id', 'Title'])
      .where({ Title: { endsWith: 'end' } })
      .execute();

    expect(ends.every((todo) => todo.Title.endsWith('end'))).toBe(true);
    expect(ends.length).toBe(1);
  });

  it('supports multiple eq filters via or', async () => {
    const inList = await client.data.Todo.select(['id', 'Title'])
      .where({
        or: [{ Title: { eq: 'Alpha urgent' } }, { Title: { eq: 'Gamma end' } }],
      })
      .execute();

    const titles = inList.map((todo) => todo.Title);
    expect(titles).toEqual(
      expect.arrayContaining(['Alpha urgent', 'Gamma end'])
    );
    expect(titles.length).toBe(2);
  });

  it('supports neq', async () => {
    const neq = await client.data.Todo.select(['id', 'Title'])
      .where({ Title: { neq: 'Alpha urgent' } })
      .execute();

    expect(neq.every((todo) => todo.Title !== 'Alpha urgent')).toBe(true);
    expect(neq.length).toBe(3);
  });

  it('supports isNull', async () => {
    const isNull = await client.data.Todo.select(['id', 'description', 'Title'])
      .where({ description: { isNull: true } })
      .execute();

    expect(isNull.every((todo) => todo.description == null)).toBe(true);
    expect(isNull.length).toBe(1);
    expect(isNull.some((todo) => todo.Title === 'Null Description')).toBe(true);
  });

  it('supports in operator', async () => {
    const inList = await client.data.Todo.select(['id', 'Title'])
      .where({ Title: { in: ['Alpha urgent', 'Gamma end'] } })
      .execute();

    const titles = inList.map((todo) => todo.Title);
    expect(titles).toEqual(
      expect.arrayContaining(['Alpha urgent', 'Gamma end'])
    );
    expect(titles.length).toBe(2);
  });
});
