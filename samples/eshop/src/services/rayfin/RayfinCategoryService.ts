import type { RayfinClient } from '@microsoft/rayfin-client';

import type { Category } from '../../../rayfin/data/Category';
import type { ZavaEshopSchema } from '../../../rayfin/data/schema';
import type {
  ICategoryService,
  CategoryFilters,
} from '../interfaces/ICategoryService';

import { getRayfinClient } from './RayfinClientService';

/**
 * Implementation of ICategoryService using \@microsoft/rayfin-data GraphQL fluent interface
 */
export class RayfinCategoryService implements ICategoryService {
  private rayfinClient: RayfinClient<ZavaEshopSchema>;

  constructor() {
    this.rayfinClient = getRayfinClient();
  }

  async getCategories(filters?: CategoryFilters): Promise<Category[]> {
    try {
      let query = this.rayfinClient.data.Category.select([
        'id',
        'name',
        'slug',
        'description',
        'image',
        'isActive',
        'sortOrder',
        // 'parentCategoryId',
        'createdAt',
        'updatedAt',
      ]);

      if (filters?.isActive !== undefined) {
        query = query.where({ isActive: { eq: filters.isActive } });
      }

      const categories = await query.orderBy({ sortOrder: 'asc' }).execute();

      // Apply client-side filtering
      let filteredCategories = categories;

      if (filters) {
        // if (filters.parentId !== undefined) {
        //   if (filters.parentId === undefined) {
        //     // Top level categories (no parent)
        //     filteredCategories = filteredCategories.filter(c => !c.parentCategoryId);
        //   } else {
        //     // Categories with specific parent
        //     filteredCategories = filteredCategories.filter(c =>
        //       c.parentCategoryId === filters.parentId
        //     );
        //   }
        // }

        if (filters.search) {
          const searchLower = filters.search.toLowerCase();
          filteredCategories = filteredCategories.filter(
            (c: any) =>
              c.name.toLowerCase().includes(searchLower) ||
              c.description?.toLowerCase().includes(searchLower)
          );
        }
      }

      return filteredCategories;
    } catch (error) {
      console.error('RayfinCategoryService.getCategories error:', error);
      throw new Error('Failed to fetch categories');
    }
  }

  async getCategory(id: string): Promise<Category | null> {
    try {
      const category = await this.rayfinClient.data.Category.select([
        'id',
        'name',
        'slug',
        'description',
        'image',
        'isActive',
        'sortOrder',
        // 'parentCategoryId',
        'createdAt',
        'updatedAt',
      ])
        .where({ id: { eq: id } })
        .first(1)
        .execute();

      return category[0] || null;
    } catch (error) {
      console.error('RayfinCategoryService.getCategory error:', error);
      throw new Error('Failed to fetch category');
    }
  }

  async getCategoryBySlug(slug: string): Promise<Category | null> {
    try {
      const category = await this.rayfinClient.data.Category.select([
        'id',
        'name',
        'slug',
        'description',
        'image',
        'isActive',
        'sortOrder',
        // 'parentCategoryId',
        'createdAt',
        'updatedAt',
      ])
        .where({ slug: { eq: slug } })
        .first(1)
        .execute();

      return category[0] || null;
    } catch (error) {
      console.error('RayfinCategoryService.getCategoryBySlug error:', error);
      throw new Error('Failed to fetch category by slug');
    }
  }

  async getTopLevelCategories(): Promise<Category[]> {
    try {
      const categories = await this.rayfinClient.data.Category.select([
        'id',
        'name',
        'slug',
        'description',
        'image',
        'isActive',
        'sortOrder',
        // 'parentCategoryId',
      ])
        .where({ isActive: { eq: true } })
        .orderBy({ sortOrder: 'asc' })
        .execute();

      // Filter for top-level categories (no parent)
      return categories; //.filter(c => !c.parentCategoryId);
    } catch (error) {
      console.error(
        'RayfinCategoryService.getTopLevelCategories error:',
        error
      );
      throw new Error('Failed to fetch top-level categories');
    }
  }

  async getSubcategories(parentId: string): Promise<Category[]> {
    return this.getCategories({ parentId, isActive: true });
  }

  // Admin operations - simplified for now
  async createCategory(
    category: Omit<Category, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Category> {
    try {
      const existingCategory = await this.getCategoryBySlug(category.slug);
      if (existingCategory) {
        return existingCategory;
      }

      const newCategory = await this.rayfinClient.data.Category.create({
        name: category.name,
        slug: category.slug,
        description: category.description,
        image: category.image,
        isActive: category.isActive,
        sortOrder: category.sortOrder,
        // parentCategoryId: category.parentCategoryId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return newCategory;
    } catch (error) {
      console.error('RayfinCategoryService.createCategory error:', error);
      throw new Error('Failed to create category');
    }
  }

  async updateCategory(
    id: string,
    updates: Partial<Omit<Category, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<Category> {
    try {
      const updatedCategory = await this.rayfinClient.data.Category.update(
        { id: id },
        {
          ...updates,
          updatedAt: new Date(),
        }
      );
      return updatedCategory;
    } catch (error) {
      console.error('RayfinCategoryService.updateCategory error:', error);
      throw new Error('Failed to update category');
    }
  }

  async deleteCategory(id: string): Promise<void> {
    try {
      await this.rayfinClient.data.Category.delete({ id: id });
    } catch (error) {
      console.error('RayfinCategoryService.deleteCategory error:', error);
      throw new Error('Failed to delete category');
    }
  }
}
