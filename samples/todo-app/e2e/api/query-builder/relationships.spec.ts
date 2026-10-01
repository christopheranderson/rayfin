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

describe('Query Builder E2E - Relationships', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  let redCategoryId: string | undefined;
  let whiteCategoryId: string | undefined;
  let emptyCategoryId: string | undefined;
  let todoId: string | undefined;
  let whiteTodoId: string | undefined;
  let todoWithoutCategoryId: string | undefined;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    const redCategory = await createCategory(client, userId, 'red');
    redCategoryId = redCategory.id;

    const whiteCategory = await createCategory(client, userId, 'white');
    whiteCategoryId = whiteCategory.id;

    const emptyCategory = await createCategory(client, userId);
    emptyCategoryId = emptyCategory.id;

    const todo1 = await createTodoWithNullableDescription(client, userId, {
      Title: 'Rel Todo 1',
      category_id: redCategoryId,
    });
    const todo2 = await createTodoWithNullableDescription(client, userId, {
      Title: 'Rel Todo 2',
      category_id: redCategoryId,
    });
    const whiteTodo = await createTodoWithNullableDescription(client, userId, {
      Title: 'Rel Todo White',
      category_id: whiteCategoryId,
    });
    whiteTodoId = whiteTodo.id;

    const todoWithoutCategory = await createTodoWithNullableDescription(
      client,
      userId,
      {
        Title: 'Rel Todo No Category',
      }
    );

    todoId = todo1.id;
    todoWithoutCategoryId = todoWithoutCategory.id;
    createdIds.push(todo1.id, todo2.id, whiteTodo.id, todoWithoutCategory.id);
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await deleteCategory(client, redCategoryId);
    await deleteCategory(client, whiteCategoryId);
    await deleteCategory(client, emptyCategoryId);
    await cleanup();
  });

  it('returns nested todos for category', async () => {
    const categories = await client.data.Category.select([
      'id',
      'name',
      'todos.id',
      'todos.Title',
    ])
      .where({ id: { eq: redCategoryId } })
      .execute();

    expect(categories).toHaveLength(1);
    const category = categories[0];
    const todos = category.todos ?? [];
    expect(todos.length).toBe(2);
    const titles = todos.map((todo: { Title: string }) => todo.Title);
    expect(titles).toEqual(
      expect.arrayContaining(['Rel Todo 1', 'Rel Todo 2'])
    );
  });

  it('returns category for a todo', async () => {
    const todos = await client.data.Todo.select([
      'id',
      'Title',
      'category.id',
      'category.name',
    ])
      .where({ id: { eq: todoId } })
      .execute();

    expect(todos).toHaveLength(1);
    const todo = todos[0];
    expect(todo.Title).toBe('Rel Todo 1');
    expect(todo.category?.id).toBe(redCategoryId);
  });

  // TODO: Get isNull on the category_id filter to work
  it('supports null relationships for todos and categories', async () => {
    const todosWithoutCategory = await client.data.Todo.select([
      'id',
      'Title',
      'category.id',
      'category.color',
    ])
      .where({ category: { isNull: true } })
      .execute();
    // verify it doesn't include todos with a red category
    expect(
      todosWithoutCategory.some((todo) => todo.id === todoWithoutCategoryId)
    ).toBe(true);

    const categories = await client.data.Category.select(['id', 'todos.id'])
      .where({ id: { eq: emptyCategoryId } })
      .execute();

    expect(categories).toHaveLength(1);
    const emptyCategory = categories[0];
    expect(emptyCategory.todos ?? []).toHaveLength(0);
  });

  it("supports querying a many to one's relationship's attributes", async () => {
    const todosWithoutCategory = await client.data.Todo.select([
      'id',
      'Title',
      'category.id',
      'category.color',
    ])
      .where({ category: { color: { eq: 'white' } } })
      .execute();
    // verify it doesn't include todos with a red category
    expect(todosWithoutCategory).toHaveLength(1);

    expect(todosWithoutCategory.some((todo) => todo.id === whiteTodoId)).toBe(
      true
    );
  });

  // TODO: Get this to work
  it.skip("supports querying a one to many's relationship's attributes", async () => {
    const categories = await client.data.Category.select([
      'id',
      'todos.id',
      'todos.Title',
    ])
      //    .where({ todos: { Title: { eq: 'Rel Todo White' } } })
      .execute();

    expect(categories).toHaveLength(1);
    const emptyCategory = categories[0];
    expect(emptyCategory.todos ?? []).toHaveLength(0);
  });
});
