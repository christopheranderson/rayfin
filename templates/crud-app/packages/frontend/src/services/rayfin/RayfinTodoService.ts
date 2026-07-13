import type { Todo } from '@workspace-todo-app/data';

import type { ITodoService } from '../interfaces/ITodoService';

import { getRayfinClient } from './RayfinClientService';

const TODO_FIELDS = [
  'id',
  'Title',
  'description',
  'isCompleted',
  'priority',
  'points',
  'percentComplete',
  'createdAt',
  'updatedAt',
  'user_id',
] as const;

export class RayfinTodoService implements ITodoService {
  async getTodos(): Promise<Todo[]> {
    const client = getRayfinClient();
    const result = await client.data.Todo.select([...TODO_FIELDS])
      .orderBy({ createdAt: 'asc' })
      .execute();
    return result as Todo[];
  }

  async createTodo(title: string): Promise<Todo> {
    const client = getRayfinClient();
    const user_id = client.auth.getSession().user?.id;
    if (!user_id) {
      throw new Error('User is not authenticated');
    }

    const now = new Date();
    const result = await client.data.Todo.create({
      Title: title,
      isCompleted: false,
      priority: 'medium',
      points: 2,
      percentComplete: 0,
      createdAt: now,
      updatedAt: now,
      user_id,
    });
    return result as Todo;
  }

  async completeTodo(id: string): Promise<Todo> {
    const client = getRayfinClient();
    // Completing a todo runs through the `completeTodo` Rayfin function. In
    // local dev the Vite proxy routes this to the `func` host when it is up
    // (otherwise the deployed function); the app code is identical either way.
    try {
      return (await client.functions.completeTodo.invoke({
        todoId: id,
      })) as Todo;
    } catch {
      // Fall back to a direct data update if the function isn't reachable
      // (no local host running and not yet deployed), so the UI still works.
      return (await client.data.Todo.update(
        { id },
        { isCompleted: true, percentComplete: 100, updatedAt: new Date() }
      )) as Todo;
    }
  }

  async reopenTodo(id: string): Promise<Todo> {
    const client = getRayfinClient();
    const result = await client.data.Todo.update(
      { id },
      { isCompleted: false, percentComplete: 0, updatedAt: new Date() }
    );
    return result as Todo;
  }

  async deleteTodo(id: string): Promise<void> {
    const client = getRayfinClient();
    await client.data.Todo.delete({ id });
  }
}
