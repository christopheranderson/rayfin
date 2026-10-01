/**
 * Schema export for the Zava eShop application
 *
 * This file exports all entity types to create a unified schema interface
 * for use with \@microsoft/rayfin-data typed client.
 */

import type { Address } from './Address.js';
import type { CartItem } from './CartItem.js';
import type { Category } from './Category.js';
import type { Customer } from './Customer.js';
import type { Order } from './Order.js';
import type { OrderItem } from './OrderItem.js';
import type { Product } from './Product.js';
import type { ProductVariant } from './ProductVariant.js';
import type { User } from './User.js';

// Re-export types for external consumption
export type {
  User,
  Customer,
  Category,
  Product,
  ProductVariant,
  CartItem,
  Address,
  Order,
  OrderItem,
};

/**
 * Complete schema interface for the Zava eShop
 * Used by RayfinClient for type-safe API operations
 */
export interface ZavaEshopSchema {
  User: User;
  Customer: Customer;
  Category: Category;
  Product: Product;
  ProductVariant: ProductVariant;
  CartItem: CartItem;
  Address: Address;
  Order: Order;
  OrderItem: OrderItem;
}
