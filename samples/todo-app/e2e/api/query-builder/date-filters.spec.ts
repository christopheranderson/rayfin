import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext, getDialect } from './setup';

// Evaluate at module load time so skipIf works correctly
const isPostgres = getDialect() === 'postgresql';

describe('Query Builder E2E - Date Filters', () => {
  // Skip date comparison tests for PostgreSQL since DAB does not support them
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  const dateEarly = new Date('2024-01-01T00:00:00.000Z');
  const dateLate = new Date('2024-02-01T00:00:00.000Z');

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    const todoEarly = await createTodoWithNullableDescription(client, userId, {
      Title: 'Early Date',
      points: 1,
      dueDate: dateEarly,
      createdAt: dateEarly,
      updatedAt: dateEarly,
    });
    const todoLate = await createTodoWithNullableDescription(client, userId, {
      Title: 'Late Date',
      points: 2,
      dueDate: dateLate,
      createdAt: dateLate,
      updatedAt: dateLate,
    });
    const todoNoDate = await createTodoWithNullableDescription(client, userId, {
      Title: 'No Date',
      points: 5,
    });

    createdIds.push(todoEarly.id, todoLate.id, todoNoDate.id);
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  it('supports isNull date operator', async () => {
    const isNull = await client.data.Todo.select(['id', 'dueDate'])
      .where({ dueDate: { isNull: true } })
      .execute();

    expect(isNull.some((todo) => todo.dueDate == null)).toBe(true);
    expect(isNull.length).toBe(1);
  });

  it.skipIf(isPostgres)('supports gte date operator', async () => {
    const gte = await client.data.Todo.select(['id', 'dueDate', 'Title'])
      .where({ dueDate: { gte: dateEarly } })
      .execute();

    expect(gte.length).toBe(2);
    expect(gte.every((todo) => todo.dueDate)).toBe(true);
  });

  it.skipIf(isPostgres)('supports eq date operator', async () => {
    const eq = await client.data.Todo.select(['id', 'dueDate'])
      .where({ dueDate: { eq: dateEarly } })
      .execute();

    expect(
      eq.some((todo) => todo.dueDate?.toISOString() === dateEarly.toISOString())
    ).toBe(true);
    expect(eq.length).toBe(1);
  });

  it.skipIf(isPostgres)('supports neq date operator', async () => {
    const neq = await client.data.Todo.select(['id', 'dueDate'])
      .where({ dueDate: { neq: dateEarly } })
      .execute();

    expect(
      neq.some((todo) => todo.dueDate?.toISOString() === dateLate.toISOString())
    ).toBe(true);
    expect(neq.some((todo) => todo.dueDate === null)).toBe(false);
    expect(neq.length).toBe(1);
  });

  it.skipIf(isPostgres)('supports gt date operator', async () => {
    const gt = await client.data.Todo.select(['id', 'dueDate'])
      .where({ dueDate: { gt: dateEarly } })
      .execute();

    expect(
      gt.every((todo) => (todo.dueDate ? todo.dueDate > dateEarly : true))
    ).toBe(true);
    expect(gt.length).toBe(1);
  });

  it.skipIf(isPostgres)('supports lt date operator', async () => {
    const lt = await client.data.Todo.select(['id', 'dueDate'])
      .where({ dueDate: { lt: dateLate } })
      .execute();

    expect(
      lt.every((todo) => (todo.dueDate ? todo.dueDate < dateLate : true))
    ).toBe(true);
    expect(lt.length).toBe(1);
  });

  it.skipIf(isPostgres)('supports lte date operator', async () => {
    const lte = await client.data.Todo.select(['id', 'dueDate'])
      .where({ dueDate: { lte: dateEarly } })
      .execute();

    expect(
      lte.some(
        (todo) => todo.dueDate?.toISOString() === dateEarly.toISOString()
      )
    ).toBe(true);
    expect(lte.length).toBe(1);
  });

  it.skipIf(isPostgres)('supports multiple eq filters via or', async () => {
    const inList = await client.data.Todo.select(['id', 'dueDate'])
      .where({
        or: [{ dueDate: { eq: dateEarly } }, { dueDate: { eq: dateLate } }],
      })
      .execute();

    const dates = inList
      .map((todo) => todo.dueDate?.toISOString())
      .filter((value): value is string => Boolean(value));
    expect(dates).toEqual(
      expect.arrayContaining([dateEarly.toISOString(), dateLate.toISOString()])
    );
  });

  it.skipIf(isPostgres)('supports in operator', async () => {
    const inList = await client.data.Todo.select(['id', 'dueDate'])
      .where({ dueDate: { in: [dateEarly, dateLate] } })
      .execute();

    const dates = inList
      .map((todo) => todo.dueDate?.toISOString())
      .filter((value): value is string => Boolean(value));
    expect(dates).toEqual(
      expect.arrayContaining([dateEarly.toISOString(), dateLate.toISOString()])
    );
    expect(dates.length).toBe(2);
  });
});
