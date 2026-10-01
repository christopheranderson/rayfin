import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext } from './setup';

describe('Query Builder E2E - Numeric Filters', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    const todoLow = await createTodoWithNullableDescription(client, userId, {
      Title: 'Low Points',
      points: 1,
    });
    const todoHigh = await createTodoWithNullableDescription(client, userId, {
      Title: 'High Points',
      points: 10,
    });
    const todoNoDate = await createTodoWithNullableDescription(client, userId, {
      Title: 'No Date',
      points: 5,
      optionalPoints: undefined,
    });
    const todoNonNullOptional = await createTodoWithNullableDescription(
      client,
      userId,
      {
        Title: 'Non-Null Optional Points',
        points: 2,
        optionalPoints: 2,
      }
    );

    createdIds.push(
      todoLow.id,
      todoHigh.id,
      todoNoDate.id,
      todoNonNullOptional.id
    );
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  it('supports gt numeric operator', async () => {
    const gt = await client.data.Todo.select(['id', 'points'])
      .where({ points: { gt: 5 } })
      .execute();

    expect(gt.every((todo) => todo.points > 5)).toBe(true);
    expect(gt.length).toBe(1);
  });

  it('supports gte numeric operator', async () => {
    const gte = await client.data.Todo.select(['id', 'points'])
      .where({ points: { gte: 5 } })
      .execute();

    expect(gte.every((todo) => todo.points >= 5)).toBe(true);
    expect(gte.length).toBe(2);
  });

  it('supports lt numeric operator', async () => {
    const lt = await client.data.Todo.select(['id', 'points'])
      .where({ points: { lt: 5 } })
      .execute();

    expect(lt.every((todo) => todo.points < 5)).toBe(true);
    expect(lt.length).toBe(2);
  });

  it('supports lte numeric operator', async () => {
    const lte = await client.data.Todo.select(['id', 'points'])
      .where({ points: { lte: 5 } })
      .execute();

    expect(lte.every((todo) => todo.points <= 5)).toBe(true);
    expect(lte.length).toBe(3);
  });

  it('supports multiple eq filters via or', async () => {
    const inList = await client.data.Todo.select(['id', 'points'])
      .where({
        or: [{ points: { eq: 1 } }, { points: { eq: 10 } }],
      })
      .execute();

    const points = inList.map((todo) => todo.points);
    expect(points).toEqual(expect.arrayContaining([1, 10]));
  });

  it('supports neq numeric operator', async () => {
    const neq = await client.data.Todo.select(['id', 'points'])
      .where({ points: { neq: 1 } })
      .execute();

    expect(neq.every((todo) => todo.points !== 1)).toBe(true);
    expect(neq.length).toBe(3);
  });

  it('supports isNull for numeric fields', async () => {
    const isNull = await client.data.Todo.select(['id', 'optionalPoints'])
      .where({ optionalPoints: { isNull: true } })
      .execute();

    expect(isNull.length).toBe(3);
    expect(isNull.every((todo) => todo.optionalPoints == null)).toBe(true);
    expect(
      isNull.some((todo) => todo.Title === 'Non-Null Optional Points')
    ).toBe(false);
  });

  it('supports in operator', async () => {
    const inList = await client.data.Todo.select(['id', 'points'])
      .where({ points: { in: [1, 10] } })
      .execute();

    const points = inList.map((todo) => todo.points);
    expect(points).toEqual(expect.arrayContaining([1, 10]));
    expect(points.length).toBe(2);
  });
});
