import type { Todo } from '../../../rayfin/data/Todo';

export interface ITodoService {
  getTodos(): Promise<Todo[]>;
  createTodo(title: string): Promise<Todo>;
  updateTodo(
    id: string,
    updates: Partial<Pick<Todo, 'title' | 'isCompleted'>>
  ): Promise<Todo>;
  deleteTodo(id: string): Promise<void>;
}
