import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Note } from '../../rayfin/data/Note';

import { ServiceContainer } from '@/services/ServiceContainer';

/**
 * Hook for managing notes
 */
export function useNotes(userId: string | null) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const services = useMemo(() => ServiceContainer.create(), []);

  const loadUserNotes = useCallback(async () => {
    if (!userId) {
      setNotes([]);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const userNotes = await services.notes.getUserNotes(userId);
      setNotes(userNotes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notes');
    } finally {
      setLoading(false);
    }
  }, [userId, services]);

  useEffect(() => {
    loadUserNotes();
  }, [loadUserNotes]);

  const createNote = async (
    noteData: Omit<Note, 'id' | 'createdAt' | 'updatedAt'>
  ) => {
    try {
      setError(null);
      const newNote = await services.notes.createNote(noteData);
      setNotes((prev) => [newNote, ...prev]);
      return newNote;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create note';
      setError(message);
      throw new Error(message);
    }
  };

  const updateNote = async (id: string, updates: Partial<Note>) => {
    try {
      setError(null);
      const updatedNote = await services.notes.updateNote(id, updates);
      setNotes((prev) =>
        prev.map((note) => (note.id === id ? updatedNote : note))
      );
      return updatedNote;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update note';
      setError(message);
      throw new Error(message);
    }
  };

  const deleteNote = async (id: string) => {
    try {
      setError(null);
      await services.notes.deleteNote(id);
      setNotes((prev) => prev.filter((note) => note.id !== id));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete note';
      setError(message);
      throw new Error(message);
    }
  };

  const searchNotes = async (query: string) => {
    if (!userId || !query.trim()) {
      return notes;
    }

    try {
      setError(null);
      const results = await services.notes.searchNotes(userId, query);
      return results;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search notes');
      return [];
    }
  };

  const getPinnedNotes = async () => {
    if (!userId) return [];

    try {
      const pinned = await services.notes.getPinnedNotes(userId);
      return pinned;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to get pinned notes'
      );
      return [];
    }
  };

  const togglePin = async (id: string) => {
    const note = notes.find((n) => n.id === id);
    if (!note) return;

    await updateNote(id, { isPinned: !note.isPinned });
  };

  const toggleArchive = async (id: string) => {
    const note = notes.find((n) => n.id === id);
    if (!note) return;

    await updateNote(id, { isArchived: !note.isArchived });
  };

  return {
    notes,
    loading,
    error,
    createNote,
    updateNote,
    deleteNote,
    searchNotes,
    getPinnedNotes,
    togglePin,
    toggleArchive,
    refreshNotes: loadUserNotes,
  };
}
