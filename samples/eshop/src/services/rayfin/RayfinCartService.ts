import type { RayfinClient } from '@microsoft/rayfin-client';

import type { CartItem } from '../../../rayfin/data/CartItem';
import type {
  Customer,
  User,
  ZavaEshopSchema,
} from '../../../rayfin/data/schema';
import type { ICartService, AddToCartData } from '../interfaces/ICartService';
import { ICustomerService } from '../interfaces/ICustomerService';

import { getRayfinClient } from './RayfinClientService';
import { RayfinCustomerService } from './RayfinCustomerService';

/**
 * Implementation of ICartService using \@microsoft/rayfin-data GraphQL fluent interface
 */
export class RayfinCartService implements ICartService {
  private rayfinClient: RayfinClient<ZavaEshopSchema>;

  constructor() {
    this.rayfinClient = getRayfinClient();
  }

  async getCart(): Promise<CartItem[]> {
    try {
      // Get all cart items for the current authenticated user
      const user = await this.getUser();

      if (!user) {
        return [];
      }

      // User filtering is handled automatically by DAB through JWT claims and RLS
      const cartItems = await this.rayfinClient.data.CartItem.select([
        'id',
        'quantity',
        'createdAt',
        'updatedAt',
        'product.id',
        'product.name',
        'product.basePrice',
        'product.imageUrl',
        'product.sku',
        'product.stockQuantity',
        'variant.id',
        'variant.size',
        'variant.color',
        'variant.originalPrice',
      ])
        .where({ user: { Email: { eq: user.Email } } })
        .orderBy({ createdAt: 'desc' })
        .execute();

      return cartItems;
    } catch (error) {
      console.error('RayfinCartService.getCart error:', error);
      throw new Error('Failed to fetch cart');
    }
  }

  async addItem(data: AddToCartData): Promise<CartItem> {
    try {
      const user = await this.getUser();

      if (!user) {
        throw new Error('Customer not found');
      }

      const newItem = await this.rayfinClient.data.CartItem.create({
        quantity: 1,
        user,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return newItem;
    } catch (error) {
      console.error('RayfinCartService.addItem error:', error);
      throw new Error('Failed to add item to cart');
    }
  }

  async updateQuantity(itemId: string, quantity: number): Promise<CartItem> {
    try {
      // Update the cart item quantity
      const updatedItem = await this.rayfinClient.data.CartItem.update(
        { id: itemId },
        {
          quantity: quantity,
          updatedAt: new Date(),
        }
      );

      return updatedItem;
    } catch (error) {
      console.error('RayfinCartService.updateQuantity error:', error);
      throw new Error('Failed to update cart item quantity');
    }
  }

  async removeItem(itemId: string): Promise<void> {
    try {
      await this.rayfinClient.data.CartItem.delete({ id: itemId });
    } catch (error) {
      console.error('RayfinCartService.removeItem error:', error);
      throw new Error('Failed to remove cart item');
    }
  }

  async clearCart(): Promise<void> {
    try {
      // Get all cart items for the current user
      const cartItems = await this.rayfinClient.data.CartItem.select([
        'id',
      ]).execute();

      // Delete each item individually
      for (const item of cartItems) {
        await this.rayfinClient.data.CartItem.delete({ id: item.id });
      }
    } catch (error) {
      console.error('RayfinCartService.clearCart error:', error);
      throw new Error('Failed to clear cart');
    }
  }

  async getCartTotal(): Promise<{ subtotal: number; itemCount: number }> {
    try {
      // Get all cart items with product pricing information
      const cartItems = await this.rayfinClient.data.CartItem.select([
        'id',
        'quantity',
        'product.basePrice',
        'variant.originalPrice',
      ]).execute();

      let subtotal = 0;
      let itemCount = 0;

      for (const item of cartItems) {
        const price = item.variant?.originalPrice || item.product.basePrice;
        subtotal += price * item.quantity;
        itemCount += item.quantity;
      }

      return { subtotal, itemCount };
    } catch (error) {
      console.error('RayfinCartService.getCartTotal error:', error);
      throw new Error('Failed to calculate cart total');
    }
  }

  private async getUser(): Promise<User | null> {
    try {
      const session = this.rayfinClient.auth.getSession();
      if (!session?.user) {
        return null;
      }
      return {
        Id: session.user.id,
        Email: session.user.email,
      };
    } catch (error) {
      console.error('RayfinCartService.getUser error:', error);
      return null;
    }
  }
}
