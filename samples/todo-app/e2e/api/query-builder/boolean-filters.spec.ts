import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext } from './setup';

describe('Query Builder E2E - Boolean Filters', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    const todoTrue = await createTodoWithNullableDescription(client, userId, {
      Title: 'Completed Todo',
      points: 1,
      isCompleted: true,
      isCompletedOptional: true,
    });
    const todoFalse = await createTodoWithNullableDescription(client, userId, {
      Title: 'Incomplete Todo',
      points: 2,
      isCompleted: false,
      isCompletedOptional: false,
    });
    const todoNull = await createTodoWithNullableDescription(client, userId, {
      Title: 'Null Optional Completion',
      points: 3,
      isCompleted: false,
      isCompletedOptional: undefined,
    });

    await client.data.Todo.update({ id: todoTrue.id }, { isCompleted: true });
    await client.data.Todo.update({ id: todoFalse.id }, { isCompleted: false });

    createdIds.push(todoTrue.id, todoFalse.id, todoNull.id);
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  it('supports eq boolean operator', async () => {
    const eq = await client.data.Todo.select(['id', 'isCompleted'])
      .where({ isCompleted: { eq: true } })
      .execute();

    expect(eq.every((todo) => todo.isCompleted === true)).toBe(true);
    expect(eq.length).toBe(1);
  });

  it('supports neq boolean operator', async () => {
    const neq = await client.data.Todo.select(['id', 'isCompleted'])
      .where({ isCompleted: { neq: true } })
      .execute();

    expect(neq.every((todo) => todo.isCompleted !== true)).toBe(true);
    expect(neq.length).toBe(2);
  });

  it('supports multiple eq filters via or', async () => {
    const inList = await client.data.Todo.select([
      'id',
      'isCompleted',
      'isCompletedOptional',
    ])
      .where({
        or: [
          { isCompletedOptional: { eq: true } },
          { isCompletedOptional: { eq: false } },
        ],
      })
      .execute();

    expect(inList.length).toBe(2);
    expect(inList.some((todo) => todo.isCompletedOptional === true)).toBe(true);
    expect(inList.some((todo) => todo.isCompletedOptional === false)).toBe(
      true
    );
    expect(inList.some((todo) => todo.isCompletedOptional === null)).toBe(
      false
    );
  });

  it('supports isNull boolean operator', async () => {
    const isNull = await client.data.Todo.select([
      'id',
      'Title',
      'isCompletedOptional',
    ])
      .where({ isCompletedOptional: { isNull: true } })
      .execute();

    expect(isNull.length).toBe(1);
    expect(isNull.every((todo) => todo.isCompletedOptional == null)).toBe(true);
    expect(isNull[0].Title).toBe('Null Optional Completion');
  });

  it('supports in operator', async () => {
    const inList = await client.data.Todo.select([
      'id',
      'isCompleted',
      'isCompletedOptional',
    ])
      .where({
        isCompletedOptional: { in: [true, false] },
      })
      .execute();

    expect(inList.length).toBe(2);
    expect(inList.some((todo) => todo.isCompletedOptional === true)).toBe(true);
    expect(inList.some((todo) => todo.isCompletedOptional === false)).toBe(
      true
    );
    expect(inList.some((todo) => todo.isCompletedOptional === null)).toBe(
      false
    );
  });
});
