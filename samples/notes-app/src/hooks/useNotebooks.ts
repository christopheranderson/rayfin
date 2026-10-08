import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Notebook } from '../../rayfin/data/Notebook';

import { ServiceContainer } from '@/services/ServiceContainer';

/**
 * Hook for managing notebooks
 */
export function useNotebooks(userId: string | null) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const services = useMemo(() => ServiceContainer.create(), []);

  const loadUserNotebooks = useCallback(async () => {
    if (!userId) {
      console.log('useNotebooks: No userId provided');
      setNotebooks([]);
      return;
    }

    try {
      console.log('useNotebooks: Loading notebooks for user:', userId);
      setLoading(true);
      setError(null);
      const userNotebooks = await services.notebooks.getUserNotebooks(userId);
      console.log('useNotebooks: Loaded notebooks:', userNotebooks);
      setNotebooks(userNotebooks);
    } catch (err) {
      console.error('useNotebooks: Error loading notebooks:', err);
      setError(err instanceof Error ? err.message : 'Failed to load notebooks');
    } finally {
      setLoading(false);
    }
  }, [userId, services.notebooks]);

  useEffect(() => {
    loadUserNotebooks();
  }, [loadUserNotebooks]);

  const createNotebook = async (
    notebookData: Omit<Notebook, 'id' | 'createdAt' | 'updatedAt'>
  ) => {
    try {
      setError(null);
      const newNotebook = await services.notebooks.createNotebook(notebookData);
      setNotebooks((prev) => {
        // If new notebook is default, clear other isDefault flags in state
        if (newNotebook.isDefault) {
          return [
            ...prev.map((nb) => ({ ...nb, isDefault: false })),
            newNotebook,
          ];
        }
        return [...prev, newNotebook];
      });
      return newNotebook;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create notebook';
      setError(message);
      throw new Error(message);
    }
  };

  const updateNotebook = async (id: string, updates: Partial<Notebook>) => {
    try {
      setError(null);
      const updatedNotebook = await services.notebooks.updateNotebook(
        id,
        updates
      );
      setNotebooks((prev) => {
        let next = prev.map((nb) => (nb.id === id ? updatedNotebook : nb));
        if (updates.isDefault) {
          next = next.map((nb) =>
            nb.id === id ? nb : { ...nb, isDefault: false }
          );
        }
        return next;
      });
      return updatedNotebook;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update notebook';
      setError(message);
      throw new Error(message);
    }
  };

  const deleteNotebook = async (id: string) => {
    try {
      setError(null);
      const target = notebooks.find((nb) => nb.id === id);
      await services.notebooks.deleteNotebook(id);
      setNotebooks((prev) => prev.filter((notebook) => notebook.id !== id));

      // If deleted notebook was default, promote another one
      if (target?.isDefault) {
        const remaining = notebooks.filter((nb) => nb.id !== id);
        const promote = remaining[0];
        if (promote) {
          try {
            const promoted = await services.notebooks.updateNotebook(
              promote.id,
              {
                isDefault: true,
              }
            );
            setNotebooks((prev) =>
              prev.map((nb) => (nb.id === promoted.id ? promoted : nb))
            );
          } catch (e) {
            console.warn('Failed to promote new default notebook:', e);
          }
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete notebook';
      setError(message);
      throw new Error(message);
    }
  };

  const getDefaultNotebook = async (): Promise<Notebook | null> => {
    if (!userId) return null;

    try {
      const defaultNotebook =
        await services.notebooks.getDefaultNotebook(userId);
      return defaultNotebook;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to get default notebook'
      );
      return null;
    }
  };

  return {
    notebooks,
    loading,
    error,
    createNotebook,
    updateNotebook,
    deleteNotebook,
    getDefaultNotebook,
    refreshNotebooks: loadUserNotebooks,
  };
}
