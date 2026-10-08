import {
  entity,
  role,
  uuid,
  int,
  text,
  date,
  set,
  one,
} from '@microsoft/rayfin-core';

import { Order } from './Order.js';
import { Product } from './Product.js';
import { ProductVariant } from './ProductVariant.js';

@entity()
@role('authenticated', '*')
export class OrderItem {
  @uuid() id!: string;
  @int() quantity!: number;
  @text() productName!: string; // Snapshot of product name at time of order
  @text() productSku!: string; // Snapshot of SKU at time of order
  @text({ optional: true }) variantName?: string; // Snapshot of variant details (size, color)
  @date() createdAt!: Date;
  @date() updatedAt!: Date;
  @set({ optional: true }, 'add', 'remove') override?: 'add' | 'remove';

  // Relationships
  @one(() => Order) order!: Order;
  @one(() => Product) product!: Product;
  @one(() => ProductVariant, { optional: true }) variant?: ProductVariant;
}
