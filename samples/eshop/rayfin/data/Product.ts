import {
  entity,
  role,
  uuid,
  text,
  decimal,
  boolean,
  int,
  date,
  one,
} from '@microsoft/rayfin-core';

import { Category } from './Category.js';

@entity()
@role('anonymous', 'read', {
  policy: (_claims, item) => item.isActive.eq(true),
})
@role('authenticated', '*')
export class Product {
  @uuid() id!: string;
  @text() name!: string;
  @text() description!: string;
  @text({ optional: true }) shortDescription?: string; // For product cards
  @decimal() basePrice!: number;
  @decimal({ optional: true }) compareAtPrice?: number; // Original price for sales
  @text() sku!: string;
  @text({ optional: true }) color?: string;
  @boolean() isActive!: boolean;
  @int() stockQuantity!: number;
  // @int() lowStockThreshold!: number;
  @text() imageUrl!: string;
  // @text() images!: string[]; // JSON array of image URLs
  // @text() features!: string[]; // JSON array of key features
  // @text() smartMaterialTech!: string; // Zava's unique selling point
  @text({ optional: true }) materialComposition?: string; // Fabric details
  @text({ optional: true }) careInstructions?: string;
  @text({ optional: true }) sizeGuide?: string; // JSON object with sizing information
  @decimal({ optional: true }) weight?: number; // Product weight in grams
  // @text() @optional() colors?: string[]; // Available colors
  // @text() @optional() tags?: string[]; // Search tags
  @text({ optional: true }) seoTitle?: string;
  @text({ optional: true }) seoDescription?: string;
  @date() createdAt!: Date;
  @date() updatedAt!: Date;

  // Relationships
  @one(() => Category) category!: Category;
}
