import { CreateInput } from '@microsoft/rayfin-data';
import { Category } from 'rayfin/data/Category';

import type { Product } from '../../../rayfin/data/Product';

export interface ProductFilters extends Omit<Partial<Product>, 'basePrice'> {
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  sortBy?: 'name' | 'price' | 'createdAt' | 'popularity';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface CreateProductData extends Omit<
  CreateInput<Product>,
  'isActive' | 'createdAt' | 'updatedAt'
> {}

export interface UpdateProductData extends Partial<CreateProductData> {
  isActive?: boolean;
}

/**
 * Interface for product catalog operations
 */
export interface IProductService {
  /**
   * Get products with optional filtering and pagination
   */
  getProducts(filters?: ProductFilters): Promise<Product[]>;

  /**
   * Get product by ID
   */
  getProduct(id: string): Promise<Product | null>;

  /**
   * Get featured products for homepage
   */
  getFeaturedProducts(limit?: number): Promise<Product[]>;

  /**
   * Search products by keyword
   */
  searchProducts(
    query: string,
    filters?: Omit<ProductFilters, 'search'>
  ): Promise<Product[]>;

  /**
   * Get related products based on category and tags
   */
  getRelatedProducts(productId: string, limit?: number): Promise<Product[]>;

  /**
   * Get products by category
   */
  getProductsByCategory(
    category: Category,
    filters?: Omit<ProductFilters, 'categoryId'>
  ): Promise<Product[]>;

  /**
   * Get low stock products (admin only)
   */
  getLowStockProducts(): Promise<Product[]>;

  // Admin operations
  /**
   * Create a new product (admin only)
   */
  createProduct(product: CreateProductData): Promise<Product>;

  /**
   * Update product information (admin only)
   */
  updateProduct(id: string, updates: UpdateProductData): Promise<Product>;

  /**
   * Delete product (admin only)
   */
  deleteProduct(id: string): Promise<void>;

  /**
   * Update product stock quantity (admin only)
   */
  updateStock(id: string, quantity: number): Promise<Product>;
}
