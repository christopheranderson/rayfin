import type { Note } from './Note.js';
import type { Notebook } from './Notebook.js';

/**
 * Schema type definition for the Notes app
 *
 * This type maps entity names to their corresponding model types,
 * enabling full type safety throughout the application when using
 * the RayfinClient and DataApi.
 *
 * Note: User entity is managed by Rayfin's control plane authentication system.
 * Note, Notebook, and Tag items are associated with users via user_id field
 * populated from JWT token claims.
 */
export type NotesAppSchema = {
  Note: Note;
  Notebook: Notebook;
};
