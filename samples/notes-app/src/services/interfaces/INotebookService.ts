import type { Notebook } from '../../../rayfin/data/Notebook';

/**
 * Notebook service interface
 * Provides CRUD operations for notebook management
 */
export interface INotebookService {
  /**
   * Get all notebooks for a user
   */
  getUserNotebooks(userId: string): Promise<Notebook[]>;

  /**
   * Create a new notebook
   */
  createNotebook(
    notebook: Omit<Notebook, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Notebook>;

  /**
   * Update an existing notebook
   */
  updateNotebook(id: string, updates: Partial<Notebook>): Promise<Notebook>;

  /**
   * Delete a notebook
   */
  deleteNotebook(id: string): Promise<void>;

  /**
   * Get the default notebook for a user
   */
  getDefaultNotebook(userId: string): Promise<Notebook>;
}
