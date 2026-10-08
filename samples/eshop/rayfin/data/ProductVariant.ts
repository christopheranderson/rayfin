import {
  entity,
  role,
  uuid,
  text,
  decimal,
  int,
  boolean,
  date,
  one,
} from '@microsoft/rayfin-core';

import { Product } from './Product.js';

@entity()
@role('anonymous', 'read')
@role('authenticated', '*')
export class ProductVariant {
  @uuid() id!: string;
  @uuid() productId!: string; // FK to Product
  @text() size!: string; // Size (XS, S, M, L, XL, etc.)
  @text() color!: string; // Color name
  @text({ optional: true }) colorHex?: string; // Hex color code for display
  @text() sku!: string; // Variant-specific SKU
  @decimal({ optional: true }) originalPrice?: number; // Variant-specific price (if different from product)
  @int() stockQuantity!: number;
  // @text() @optional() images?: string[]; // Variant-specific images
  @boolean() isActive!: boolean;
  @date() createdAt!: Date;
  @date() updatedAt!: Date;

  // Relationships
  @one(() => Product) product!: Product;
}
