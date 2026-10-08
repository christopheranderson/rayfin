import type { RayfinClient } from '@microsoft/rayfin-client';

import type { Notebook } from '../../../rayfin/data/Notebook';
import type { NotesAppSchema } from '../../../rayfin/data/schema';
import type { INotebookService } from '../interfaces/INotebookService';

import { getRayfinClient } from './RayfinClientService';

/**
 * Implementation of INotebookService using \@microsoft/rayfin-data GraphQL fluent interface
 *
 * This service uses the rayfinClient.data.gql property to access the GraphQL API,
 * providing type-safe query building and execution with fluent syntax for notebook operations.
 */
export class RayfinNotebookService implements INotebookService {
  private rayfinClient: RayfinClient<NotesAppSchema>;

  constructor() {
    // Get the RayfinClient instance once during initialization
    this.rayfinClient = getRayfinClient();
  }

  async getUserNotebooks(_userId: string): Promise<Notebook[]> {
    try {
      // Use the GraphQL fluent interface for notebook queries
      // User filtering is handled automatically by DAB through JWT claims and RLS
      const notebooks = await this.rayfinClient.data.Notebook.select([
        'id',
        'name',
        'description',
        'color',
        'isDefault',
        'createdAt',
        'updatedAt',
        'user_id',
      ])
        .orderBy({ name: 'asc' })
        .execute();

      return notebooks;
    } catch (error) {
      console.error('RayfinNotebookService.getUserNotebooks error:', error);
      throw new Error('Failed to fetch notebooks');
    }
  }

  async createNotebook(
    notebook: Omit<Notebook, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Notebook> {
    try {
      // Verify user is authenticated before creating notebook
      const session = this.rayfinClient.auth.getSession();
      if (!session?.isAuthenticated || !session.user?.id) {
        throw new Error('User must be authenticated to create notebooks');
      }

      const notebookData: Omit<Notebook, 'id' | 'notes'> = {
        name: notebook.name,
        description: notebook.description,
        color: notebook.color,
        isDefault: notebook.isDefault,
        user_id: session.user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Use GraphQL mutation for creation
      const newNotebook =
        await this.rayfinClient.data.Notebook.create(notebookData);

      return newNotebook;
    } catch (error) {
      console.error('RayfinNotebookService.createNotebook error:', error);
      throw new Error('Failed to create notebook');
    }
  }

  async updateNotebook(
    id: string,
    updates: Partial<Notebook>
  ): Promise<Notebook> {
    try {
      // If setting as default, unset all other default notebooks first
      if (updates.isDefault === true) {
        const allNotebooks = await this.rayfinClient.data.Notebook.select([
          'id',
          'isDefault',
        ]).execute();

        const updatePromises = allNotebooks
          .filter((nb) => nb.id !== id && nb.isDefault)
          .map((nb) =>
            this.rayfinClient.data.Notebook.update(
              { id: nb.id },
              { isDefault: false, updatedAt: new Date() }
            )
          );

        await Promise.all(updatePromises);
      }

      // Prepare updates with timestamp
      const notebookUpdates = {
        ...updates,
        updatedAt: new Date(),
      };

      // Use GraphQL mutation for update - requires WhereUniqueInput format
      await this.rayfinClient.data.Notebook.update(
        { id }, // WhereUniqueInput format
        notebookUpdates
      );

      // Fetch the updated notebook to return
      const updatedNotebooks = await this.rayfinClient.data.Notebook.select([
        'id',
        'name',
        'description',
        'color',
        'isDefault',
        'createdAt',
        'updatedAt',
        'user_id',
      ])
        .where({ id: { eq: id } })
        .first(1)
        .execute();

      if (!updatedNotebooks || updatedNotebooks.length === 0) {
        throw new Error(`Notebook with id ${id} not found after update`);
      }

      return updatedNotebooks[0];
    } catch (error) {
      console.error('RayfinNotebookService.updateNotebook error:', error);
      throw new Error('Failed to update notebook');
    }
  }

  async deleteNotebook(id: string): Promise<void> {
    try {
      // Delete notes belonging to this notebook first
      try {
        const notes = await this.rayfinClient.data.Note.select(['id'])
          .where({ notebook_id: { eq: id } })
          .execute();
        if (notes && notes.length > 0) {
          await Promise.all(
            notes.map((n: { id: string }) =>
              this.rayfinClient.data.Note.delete({ id: n.id })
            )
          );
        }
      } catch (noteErr) {
        console.warn(
          'Failed to delete notebook notes; proceeding to delete notebook',
          noteErr
        );
      }
      // Use GraphQL mutation for deletion
      await this.rayfinClient.data.Notebook.delete({ id });
    } catch (error) {
      console.error('RayfinNotebookService.deleteNotebook error:', error);
      throw new Error('Failed to delete notebook');
    }
  }

  async getDefaultNotebook(_userId: string): Promise<Notebook> {
    try {
      // Query for the default notebook
      const notebooks = await this.rayfinClient.data.Notebook.select([
        'id',
        'name',
        'description',
        'color',
        'isDefault',
        'createdAt',
        'updatedAt',
        'user_id',
      ])
        .where({ isDefault: { eq: true } })
        .first(1)
        .execute();

      if (!notebooks || notebooks.length === 0) {
        throw new Error('No default notebook found for user');
      }

      return notebooks[0];
    } catch (error) {
      console.error('RayfinNotebookService.getDefaultNotebook error:', error);
      throw new Error('Failed to fetch default notebook');
    }
  }
}
