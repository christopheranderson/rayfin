import type { Todo } from '@workspace-todo-app/data';

export interface ITodoService {
  getTodos(): Promise<Todo[]>;
  createTodo(title: string): Promise<Todo>;
  /** Mark complete server-side via the `completeTodo` Rayfin function. */
  completeTodo(id: string): Promise<Todo>;
  /** Re-open a completed todo (a plain data update). */
  reopenTodo(id: string): Promise<Todo>;
  deleteTodo(id: string): Promise<void>;
}
