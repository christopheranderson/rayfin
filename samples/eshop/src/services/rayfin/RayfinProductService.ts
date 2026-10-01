import type { RayfinClient } from '@microsoft/rayfin-client';

import type { Product } from '../../../rayfin/data/Product';
import type { Category, ZavaEshopSchema } from '../../../rayfin/data/schema';
import type {
  IProductService,
  ProductFilters,
  CreateProductData,
  UpdateProductData,
} from '../interfaces/IProductService';

import { getRayfinClient } from './RayfinClientService';

/**
 * Implementation of IProductService using \@microsoft/rayfin-data GraphQL fluent interface
 *
 * This service uses the rayfinClient.data.gql property to access the GraphQL API,
 * providing type-safe query building and execution with fluent syntax.
 */
export class RayfinProductService implements IProductService {
  private rayfinClient: RayfinClient<ZavaEshopSchema>;

  constructor() {
    // Get the RayfinClient instance once during initialization
    this.rayfinClient = getRayfinClient();
  }

  async getProducts(filters?: ProductFilters): Promise<Product[]> {
    try {
      // Basic query for products with category information
      const products = await this.rayfinClient.data.Product.select([
        'id',
        'name',
        'description',
        'shortDescription',
        'basePrice',
        'compareAtPrice',
        'sku',
        'isActive',
        'stockQuantity',
        'createdAt',
        'updatedAt',
        'imageUrl',
        'category.id',
        'category.name',
        'category.slug',
      ])
        .orderBy({ createdAt: 'desc' })
        .execute();

      // Apply client-side filtering for now
      let filteredProducts = products;

      if (filters) {
        if (filters.category) {
          filteredProducts = filteredProducts.filter(
            (p) => p.category === filters.category
          );
        }

        if (filters.minPrice !== undefined) {
          filteredProducts = filteredProducts.filter(
            (p) => p.basePrice >= filters.minPrice!
          );
        }

        if (filters.maxPrice !== undefined) {
          filteredProducts = filteredProducts.filter(
            (p) => p.basePrice <= filters.maxPrice!
          );
        }

        if (filters.inStock) {
          filteredProducts = filteredProducts.filter(
            (p) => p.stockQuantity > 0
          );
        }

        // if (filters.search) {
        //   const searchLower = filters.search.toLowerCase();
        //   filteredProducts = filteredProducts.filter(p =>
        //     p.name.toLowerCase().includes(searchLower) ||
        //     p.description.toLowerCase().includes(searchLower)
        //   );
        // }

        // Apply pagination
        if (filters.page && filters.limit) {
          const start = (filters.page - 1) * filters.limit;
          const end = start + filters.limit;
          filteredProducts = filteredProducts.slice(start, end);
        }
      }

      return filteredProducts;
    } catch (error) {
      console.error('RayfinProductService.getProducts error:', error);
      throw new Error('Failed to fetch products');
    }
  }

  async getProduct(id: string): Promise<Product | null> {
    try {
      const product = await this.rayfinClient.data.Product.select([
        'id',
        'name',
        'description',
        'shortDescription',
        'basePrice',
        'compareAtPrice',
        'sku',
        'isActive',
        'stockQuantity',
        'materialComposition',
        'careInstructions',
        'sizeGuide',
        'imageUrl',
        'weight',
        'seoTitle',
        'seoDescription',
        'createdAt',
        'updatedAt',
        'category.id',
        'category.name',
        'category.slug',
        'category.description',
      ])
        // .where({ id: { eq: id } })
        .first(1)
        .execute();

      return product[0] || null;
    } catch (error) {
      console.error('RayfinProductService.getProduct error:', error);
      throw new Error('Failed to fetch product');
    }
  }

  async getFeaturedProducts(limit = 8): Promise<Product[]> {
    try {
      const products = await this.rayfinClient.data.Product.select([
        'id',
        'name',
        'description',
        'shortDescription',
        'imageUrl',
        'basePrice',
        'compareAtPrice',
        'sku',
        'category.name',
        'category.slug',
      ])
        .where({
          // isActive: { eq: true },
          stockQuantity: { gt: 0 },
        })
        .orderBy({ createdAt: 'desc' })
        .execute();

      // // Filter for featured products client-side
      // const featuredProducts = products.filter(p =>
      //   p.tags?.includes('featured')
      // ).slice(0, limit);

      return products;
    } catch (error) {
      console.error('RayfinProductService.getFeaturedProducts error:', error);
      throw new Error('Failed to fetch featured products');
    }
  }

  async searchProducts(
    query: string,
    filters?: Omit<ProductFilters, 'search'>
  ): Promise<Product[]> {
    return this.getProducts({ ...filters }); //TODO: search: query
  }

  async getRelatedProducts(productId: string, limit = 4): Promise<Product[]> {
    try {
      // First get the product to find its category
      const product = await this.getProduct(productId);
      if (!product) {
        return [];
      }

      // Get products from the same category
      const categoryProducts = await this.getProductsByCategory(
        product.category,
        { limit: limit + 1 } // Get one extra to exclude current product
      );

      // Filter out the current product and limit results
      return categoryProducts.filter((p) => p.id !== productId).slice(0, limit);
    } catch (error) {
      console.error('RayfinProductService.getRelatedProducts error:', error);
      throw new Error('Failed to fetch related products');
    }
  }

  async getProductsByCategory(
    category: Category,
    filters?: Omit<ProductFilters, 'categoryId'>
  ): Promise<Product[]> {
    return this.getProducts({ ...filters, category });
  }

  async getLowStockProducts(): Promise<Product[]> {
    try {
      const products = await this.rayfinClient.data.Product.select([
        'id',
        'name',
        'sku',
        'stockQuantity',
        'category.name',
      ])
        .where({ isActive: { eq: true } })
        .execute();

      // Filter products where stock is below threshold
      return products.filter((product) => product.stockQuantity <= 10);
    } catch (error) {
      console.error('RayfinProductService.getLowStockProducts error:', error);
      throw new Error('Failed to fetch low stock products');
    }
  }

  async createProduct(product: CreateProductData): Promise<Product> {
    try {
      return await this.rayfinClient.data.Product.create({
        ...product,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (error) {
      console.error('RayfinProductService.createProduct error:', error);
      throw new Error('Failed to create product');
    }
  }

  async updateProduct(
    id: string,
    updates: UpdateProductData
  ): Promise<Product> {
    try {
      // For now, throw an error indicating this needs to be implemented
      throw new Error(
        'Product update not yet implemented - requires DAB configuration'
      );
    } catch (error) {
      console.error('RayfinProductService.updateProduct error:', error);
      throw new Error('Failed to update product');
    }
  }

  async deleteProduct(id: string): Promise<void> {
    try {
      this.rayfinClient.data.Product.delete({ id });
    } catch (error) {
      console.error('RayfinProductService.deleteProduct error:', error);
      throw new Error('Failed to delete product');
    }
  }

  async updateStock(id: string, quantity: number): Promise<Product> {
    return this.updateProduct(id, { stockQuantity: quantity });
  }
}
