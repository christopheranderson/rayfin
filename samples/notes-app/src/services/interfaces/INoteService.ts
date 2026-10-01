import type { Note } from '../../../rayfin/data/Note';

/**
 * Note service interface
 * Provides CRUD operations for note management
 */
export interface INoteService {
  /**
   * Get all notes for a user
   */
  getUserNotes(userId: string): Promise<Note[]>;

  /**
   * Get notes by notebook
   */
  getNotebookNotes(notebookId: string): Promise<Note[]>;

  /**
   * Get a specific note by ID
   */
  getNote(id: string): Promise<Note | null>;

  /**
   * Create a new note
   */
  createNote(note: Omit<Note, 'id' | 'createdAt' | 'updatedAt'>): Promise<Note>;

  /**
   * Update an existing note
   */
  updateNote(id: string, updates: Partial<Note>): Promise<Note>;

  /**
   * Delete a note
   */
  deleteNote(id: string): Promise<void>;

  /**
   * Search notes by content
   */
  searchNotes(userId: string, query: string): Promise<Note[]>;

  /**
   * Get pinned notes for a user
   */
  getPinnedNotes(userId: string): Promise<Note[]>;
}
