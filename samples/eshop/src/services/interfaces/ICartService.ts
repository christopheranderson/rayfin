import type { CartItem } from '../../../rayfin/data/CartItem';
import { Product } from '../../../rayfin/data/Product';

export interface AddToCartData {
  product: Product;
  variantId?: string;
  quantity?: number;
}

/**
 * Interface for shopping cart operations
 */
export interface ICartService {
  /**
   * Get current user's cart items
   */
  getCart(): Promise<CartItem[]>;

  /**
   * Add item to cart or update quantity if already exists
   */
  addItem(data: AddToCartData): Promise<CartItem>;

  /**
   * Update quantity of cart item
   */
  updateQuantity(itemId: string, quantity: number): Promise<CartItem>;

  /**
   * Remove item from cart
   */
  removeItem(itemId: string): Promise<void>;

  /**
   * Clear all items from cart
   */
  clearCart(): Promise<void>;

  /**
   * Get cart total (calculated from items)
   */
  getCartTotal(): Promise<{ subtotal: number; itemCount: number }>;
}
