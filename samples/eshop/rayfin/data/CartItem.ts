import { entity, role, uuid, int, date, one } from '@microsoft/rayfin-core';

import { Product } from './Product.js';
import { ProductVariant } from './ProductVariant.js';
import { User } from './User.js';

@entity()
@role('authenticated', '*')
export class CartItem {
  @uuid() id!: string;
  // @uuid() customerId!: string; // FK to Customer
  // @uuid() productId!: string; // FK to Product
  // @uuid() @optional() variantId?: string; // FK to ProductVariant (optional)
  @int() quantity!: number;
  // @decimal() priceAtTime!: number; // Price when added to cart
  @date() createdAt!: Date;
  @date() updatedAt!: Date;

  // Relationships
  @one(() => User) user!: User;
  @one(() => Product) product!: Product;
  @one(() => ProductVariant, { optional: true }) variant?: ProductVariant;
}
