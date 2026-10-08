import type { Category } from '../../../rayfin/data/Category';

export interface CategoryFilters {
  parentId?: string;
  isActive?: boolean;
  search?: string;
}

/**
 * Interface for category management operations
 */
export interface ICategoryService {
  /**
   * Get all categories with optional filtering
   */
  getCategories(filters?: CategoryFilters): Promise<Category[]>;

  /**
   * Get category by ID
   */
  getCategory(id: string): Promise<Category | null>;

  /**
   * Get category by slug
   */
  getCategoryBySlug(slug: string): Promise<Category | null>;

  /**
   * Get top-level categories (no parent)
   */
  getTopLevelCategories(): Promise<Category[]>;

  /**
   * Get subcategories for a parent category
   */
  getSubcategories(parentId: string): Promise<Category[]>;

  // Admin operations
  /**
   * Create a new category (admin only)
   */
  createCategory(
    category: Omit<Category, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Category>;

  /**
   * Update category information (admin only)
   */
  updateCategory(
    id: string,
    updates: Partial<Omit<Category, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<Category>;

  /**
   * Delete category (admin only)
   */
  deleteCategory(id: string): Promise<void>;
}
