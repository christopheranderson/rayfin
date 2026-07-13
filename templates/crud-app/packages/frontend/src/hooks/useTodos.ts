import { useCallback, useEffect, useState } from 'react';

import type { Todo } from '@workspace-todo-app/data';

import { ServiceContainer } from '../services/ServiceContainer';

interface UseTodosResult {
  todos: Todo[];
  loading: boolean;
  error: string | null;
  addTodo: (title: string) => Promise<void>;
  toggleTodo: (id: string, isCompleted: boolean) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useTodos(): UseTodosResult {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const todoService = ServiceContainer.getInstance().todoService;

  const fetchTodos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTodos(await todoService.getTodos());
    } catch (err) {
      console.error('Failed to fetch todos:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch todos');
    } finally {
      setLoading(false);
    }
  }, [todoService]);

  const addTodo = useCallback(
    async (title: string) => {
      setError(null);
      try {
        const created = await todoService.createTodo(title);
        setTodos((prev) => [...prev, created]);
      } catch (err) {
        console.error('Failed to add todo:', err);
        setError(err instanceof Error ? err.message : 'Failed to add todo');
        throw err;
      }
    },
    [todoService]
  );

  const toggleTodo = useCallback(
    async (id: string, isCompleted: boolean) => {
      setError(null);
      // Optimistic update so the checkbox responds immediately.
      setTodos((prev) =>
        prev.map((todo) => (todo.id === id ? { ...todo, isCompleted } : todo))
      );
      try {
        const updated = isCompleted
          ? await todoService.completeTodo(id)
          : await todoService.reopenTodo(id);
        setTodos((prev) =>
          prev.map((todo) => (todo.id === id ? { ...todo, ...updated } : todo))
        );
      } catch (err) {
        console.error('Failed to toggle todo:', err);
        setError(err instanceof Error ? err.message : 'Failed to update todo');
        // Roll back the optimistic update.
        setTodos((prev) =>
          prev.map((todo) =>
            todo.id === id ? { ...todo, isCompleted: !isCompleted } : todo
          )
        );
        throw err;
      }
    },
    [todoService]
  );

  const deleteTodo = useCallback(
    async (id: string) => {
      setError(null);
      const previous = todos;
      setTodos((prev) => prev.filter((todo) => todo.id !== id));
      try {
        await todoService.deleteTodo(id);
      } catch (err) {
        console.error('Failed to delete todo:', err);
        setError(err instanceof Error ? err.message : 'Failed to delete todo');
        setTodos(previous);
        throw err;
      }
    },
    [todos, todoService]
  );

  useEffect(() => {
    fetchTodos();
  }, [fetchTodos]);

  return {
    todos,
    loading,
    error,
    addTodo,
    toggleTodo,
    deleteTodo,
    refresh: fetchTodos,
  };
}
