import type { RayfinClient } from '@microsoft/rayfin-client';

import type { Note } from '../../../rayfin/data/Note';
import type { NotesAppSchema } from '../../../rayfin/data/schema';
import type { INoteService } from '../interfaces/INoteService';

import { getRayfinClient } from './RayfinClientService';

/**
 * Implementation of INoteService using \@microsoft/rayfin-data GraphQL fluent interface
 *
 * This service uses the rayfinClient.data.gql property to access the GraphQL API,
 * providing type-safe query building and execution with fluent syntax.
 */
export class RayfinNoteService implements INoteService {
  private rayfinClient: RayfinClient<NotesAppSchema>;

  constructor() {
    // Get the RayfinClient instance once during initialization
    this.rayfinClient = getRayfinClient();
  }

  async getUserNotes(_userId: string): Promise<Note[]> {
    try {
      // Use the GraphQL fluent interface for more sophisticated queries
      // User filtering is handled automatically by DAB through JWT claims and RLS
      const notes = await this.rayfinClient.data.Note.select([
        'id',
        'title',
        'content',
        'contentType',
        'isPinned',
        'isArchived',
        'createdAt',
        'updatedAt',
        'user_id',
        'notebook_id',
        'notebook.id',
        'notebook.name',
        'notebook.color',
      ])
        .orderBy({ createdAt: 'desc' })
        .execute();

      // Sort pinned notes to the top
      return this.sortWithPinnedFirst(notes);
    } catch (error) {
      console.error('RayfinNoteService.getUserNotes error:', error);
      throw new Error('Failed to fetch notes');
    }
  }

  async getNotebookNotes(notebookId: string): Promise<Note[]> {
    try {
      const notes = await this.rayfinClient.data.Note.select([
        'id',
        'title',
        'content',
        'contentType',
        'isPinned',
        'isArchived',
        'createdAt',
        'updatedAt',
        'user_id',
        'notebook_id',
        'notebook.id',
        'notebook.name',
        'notebook.color',
      ])
        .where({ notebook_id: { eq: notebookId } })
        .orderBy({ createdAt: 'desc' })
        .execute();

      // Sort pinned notes to the top
      return this.sortWithPinnedFirst(notes);
    } catch (error) {
      console.error('RayfinNoteService.getNotebookNotes error:', error);
      throw new Error('Failed to fetch notebook notes');
    }
  }

  async getNote(id: string): Promise<Note | null> {
    try {
      const notes = await this.rayfinClient.data.Note.select([
        'id',
        'title',
        'content',
        'contentType',
        'isPinned',
        'isArchived',
        'createdAt',
        'updatedAt',
        'user_id',
        'notebook_id',
        'notebook.id',
        'notebook.name',
        'notebook.color',
      ])
        .where({ id: { eq: id } })
        .first(1)
        .execute();

      return notes[0] || null;
    } catch (error) {
      console.error('RayfinNoteService.getNote error:', error);
      return null;
    }
  }

  async createNote(
    note: Omit<Note, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Note> {
    try {
      // Prepare the note data with auto-generated fields
      const noteData = {
        ...note,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const newNote = await this.rayfinClient.data.Note.create(noteData);

      // Fetch the full note with relationships
      const newNoteWithRelations = await this.getNote(newNote.id);
      if (!newNoteWithRelations) {
        throw new Error(`Note with id ${newNote.id} not found after creation`);
      }
      return newNoteWithRelations;
    } catch (error) {
      console.error('RayfinNoteService.createNote error:', error);
      throw new Error('Failed to create note');
    }
  }

  async updateNote(id: string, updates: Partial<Note>): Promise<Note> {
    try {
      // Prepare updates with timestamp
      const noteUpdates = {
        ...updates,
        updatedAt: new Date(),
      };

      // Use GraphQL mutation for update
      await this.rayfinClient.data.Note.update({ id }, noteUpdates);

      // Fetch the updated note to return
      const updatedNote = await this.getNote(id);
      if (!updatedNote) {
        throw new Error(`Note with id ${id} not found after update`);
      }
      return updatedNote;
    } catch (error) {
      console.error('RayfinNoteService.updateNote error:', error);
      throw new Error('Failed to update note');
    }
  }

  async deleteNote(id: string): Promise<void> {
    try {
      // Use GraphQL mutation for deletion
      await this.rayfinClient.data.Note.delete({ id });
    } catch (error) {
      console.error('RayfinNoteService.deleteNote error:', error);
      throw new Error('Failed to delete note');
    }
  }

  async searchNotes(userId: string, query: string): Promise<Note[]> {
    try {
      const notes = await this.rayfinClient.data.Note.select([
        'id',
        'title',
        'content',
        'contentType',
        'isPinned',
        'isArchived',
        'createdAt',
        'updatedAt',
        'user_id',
        'notebook_id',
        'notebook.id',
        'notebook.name',
        'notebook.color',
      ])
        .where({
          or: [
            { title: { contains: query } },
            { content: { contains: query } },
          ],
        })
        .orderBy({ createdAt: 'desc' })
        .execute();

      return notes;
    } catch (error) {
      console.error('RayfinNoteService.searchNotes error:', error);
      throw new Error('Failed to search notes');
    }
  }

  async getPinnedNotes(_userId: string): Promise<Note[]> {
    try {
      const notes = await this.rayfinClient.data.Note.select([
        'id',
        'title',
        'content',
        'contentType',
        'isPinned',
        'isArchived',
        'createdAt',
        'updatedAt',
        'user_id',
        'notebook_id',
        'notebook.id',
        'notebook.name',
        'notebook.color',
      ])
        .where({ isPinned: { eq: true } })
        .orderBy({ createdAt: 'desc' })
        .execute();

      return notes;
    } catch (error) {
      console.error('RayfinNoteService.getPinnedNotes error:', error);
      throw new Error('Failed to fetch pinned notes');
    }
  }

  /**
   * Sort notes with pinned notes first, then by creation date descending
   */
  private sortWithPinnedFirst(notes: Note[]): Note[] {
    return notes.sort((a, b) => {
      // Pinned notes come first
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;

      // Within each group (pinned/unpinned), sort by creation date descending
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
  }
}
