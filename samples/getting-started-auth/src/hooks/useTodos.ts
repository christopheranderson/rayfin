import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Todo } from '../../rayfin/data/Todo';
import { ServiceContainer } from '../services/ServiceContainer';

export type TodoWithAction = Todo & {
  buttonTitle?: string;
  buttonUrl?: string;
};

interface MilestoneTask {
  title: string;
  completed: boolean | undefined;
  buttonTitle?: string;
  buttonUrl?: string;
}

/**
 * Builds the milestone task list using Fabric coordinates resolved from the
 * runtime config (via {@link ServiceContainer.getFabricConfig}), not
 * build-time `VITE_FABRIC_*` constants. Computing this eagerly at module
 * scope would read those env vars before `ServiceContainer.create()` even
 * runs (ES module evaluation order), so a promoted artifact would always
 * link back to the ORIGINAL build's workspace/item — never the deployed
 * one.
 */
function buildMilestoneTasks(): MilestoneTask[] {
  const { workspaceId, itemId, portalUrl } = ServiceContainer.getFabricConfig();
  const isDeployed = !!portalUrl;
  const managementPageUrl =
    workspaceId && itemId && portalUrl
      ? `${new URL(portalUrl).origin}/groups/${workspaceId}/appbackends/${itemId}?experience=fabric-developer`
      : '#';

  return [
    {
      title: 'Create and publish your app',
      completed: isDeployed,
    },
    {
      title: 'Visit your app page in Fabric',
      completed: undefined,
      ...(isDeployed && {
        buttonTitle: 'Open in Fabric',
        buttonUrl: managementPageUrl,
      }),
    },
    { title: 'Edit your app using GitHub Copilot Chat', completed: undefined },
    {
      title: 'Publish your changes. Run npx rayfin up or just ask your agent',
      completed: undefined,
    },
  ];
}

interface UseTodosResult {
  todos: TodoWithAction[];
  loading: boolean;
  error: string | null;
  addTodo: (title: string) => Promise<void>;
  toggleTodo: (id: string, isCompleted: boolean) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useTodos(): UseTodosResult {
  const [todos, setTodos] = useState<TodoWithAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const todoService = ServiceContainer.getInstance().todoService;
  // ServiceContainer is fully initialized (and its resolved Fabric config
  // set) before this hook can ever run — main.tsx awaits
  // ServiceContainer.create() before rendering <App />.
  const milestoneTasks = useMemo(() => buildMilestoneTasks(), []);

  const fetchTodos = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await todoService.getTodos();

      // Seed milestone tasks on first load if DB is empty
      if (data.length === 0) {
        for (const milestone of milestoneTasks) {
          const created = await todoService.createTodo(milestone.title);
          if (milestone.completed) {
            await todoService.updateTodo(created.id, { isCompleted: true });
          }
        }
        const seededData = await todoService.getTodos();
        data.length = 0;
        data.push(...seededData);
      } else {
        // Reconcile milestone completion based on current deploy state
        const milestoneByTitle = new Map(
          milestoneTasks.map((m) => [m.title, m])
        );
        for (const todo of data) {
          const milestone = milestoneByTitle.get(todo.title);
          if (
            milestone &&
            milestone.completed !== undefined &&
            milestone.completed !== todo.isCompleted
          ) {
            await todoService.updateTodo(todo.id, {
              isCompleted: milestone.completed,
            });
            todo.isCompleted = milestone.completed;
          }
        }
      }

      // Apply button metadata in-memory from milestone config
      const milestoneByTitle = new Map(milestoneTasks.map((m) => [m.title, m]));
      const enriched: TodoWithAction[] = data.map((todo) => {
        const milestone = milestoneByTitle.get(todo.title);
        return milestone
          ? {
              ...todo,
              buttonTitle: milestone.buttonTitle,
              buttonUrl: milestone.buttonUrl,
            }
          : todo;
      });
      setTodos(enriched);
    } catch (err) {
      console.error('Failed to fetch todos:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch todos');
    } finally {
      setLoading(false);
    }
  }, [todoService, milestoneTasks]);

  const addTodo = useCallback(
    async (title: string) => {
      setError(null);
      try {
        const newTodo = await todoService.createTodo(title);
        setTodos((prev) => [...prev, newTodo]);
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
      try {
        const updated = await todoService.updateTodo(id, { isCompleted });
        setTodos((prev) =>
          prev.map((todo) => (todo.id === id ? { ...todo, ...updated } : todo))
        );
      } catch (err) {
        console.error('Failed to toggle todo:', err);
        setError(err instanceof Error ? err.message : 'Failed to update todo');
        throw err;
      }
    },
    [todoService]
  );

  const deleteTodo = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await todoService.deleteTodo(id);
        setTodos((prev) => prev.filter((todo) => todo.id !== id));
      } catch (err) {
        console.error('Failed to delete todo:', err);
        setError(err instanceof Error ? err.message : 'Failed to delete todo');
        throw err;
      }
    },
    [todoService]
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
