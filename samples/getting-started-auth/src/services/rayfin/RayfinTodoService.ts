import type { Todo } from '../../../rayfin/data/Todo';
import { ITodoService } from '../interfaces/ITodoService';

import { getRayfinClient } from './RayfinClientService';

export class RayfinTodoService implements ITodoService {
  async getTodos(): Promise<Todo[]> {
    const client = getRayfinClient();
    const result = await client.data.Todo.select([
      'id',
      'title',
      'isCompleted',
      'createdAt',
    ])
      .orderBy({ createdAt: 'asc' })
      .execute();

    return result;
  }

  async createTodo(title: string): Promise<Todo> {
    const client = getRayfinClient();
    const user_id = client.auth.getSession().user?.id;
    if (!user_id) {
      throw new Error('User is not authenticated');
    }

    const result = await client.data.Todo.create({
      title,
      isCompleted: false,
      createdAt: new Date(),
      user_id,
    });

    return result;
  }

  async updateTodo(
    id: string,
    updates: Partial<Pick<Todo, 'title' | 'isCompleted'>>
  ): Promise<Todo> {
    const client = getRayfinClient();
    const result = await client.data.Todo.update({ id }, updates);
    return result;
  }

  async deleteTodo(id: string): Promise<void> {
    const client = getRayfinClient();
    await client.data.Todo.delete({ id });
  }
}
