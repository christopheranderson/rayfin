import type { RayfinClient } from '@microsoft/rayfin-client';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';
import {
  generateUniqueCategory,
  generateUniqueTodo,
} from '../../shared/test-data';

export interface SeededTodo {
  id: string;
  Title: string;
  description?: string;
  priority: 'low' | 'medium' | 'high';
  points: number;
  optionalPoints?: number;
  percentComplete: number;
  dueDate?: Date;
  createdAt: Date;
  updatedAt: Date;
  isCompleted?: boolean;
  isCompletedOptional?: boolean;
  user_id: string;
  category_id?: string;
}

export async function createCategory(
  client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>,
  userId: string,
  color?: string
) {
  const category = generateUniqueCategory();
  return client.data.Category.create({
    name: category.name,
    color: color ?? category.color,
    user_id: userId,
  });
}

export async function createTodoWithNullableDescription(
  client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>,
  userId: string,
  overrides: Partial<SeededTodo> = {}
) {
  const todoSeed = generateUniqueTodo();
  const now = new Date();
  const hasDescriptionOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    'description'
  );

  return client.data.Todo.create({
    Title: overrides.Title ?? todoSeed.title,
    description: hasDescriptionOverride
      ? overrides.description
      : todoSeed.description,
    isCompleted: overrides.isCompleted ?? false,
    isCompletedOptional: overrides.isCompletedOptional ?? undefined,
    priority: overrides.priority ?? 'medium',
    points: overrides.points ?? 1,
    optionalPoints: overrides.optionalPoints ?? undefined,
    percentComplete: overrides.percentComplete ?? 0,
    dueDate: overrides.dueDate,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    user_id: userId,
    category: overrides.category_id ? { id: overrides.category_id } : undefined,
  });
}

export async function deleteTodos(
  client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>,
  todoIds: string[]
) {
  for (const id of todoIds) {
    await client.data.Todo.delete({ id });
  }
}

export async function deleteCategory(
  client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>,
  categoryId?: string
) {
  if (!categoryId) return;
  await client.data.Category.delete({ id: categoryId });
}
