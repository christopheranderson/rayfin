import {
  entity,
  role,
  uuid,
  text,
  boolean,
  int,
  date,
} from '@microsoft/rayfin-core';

@entity()
@role('anonymous', 'read')
@role('authenticated', '*')
export class Category {
  @uuid() id!: string;
  @text() name!: string;
  @text() slug!: string; // URL-friendly version of name
  @text({ optional: true }) description?: string;
  @text({ optional: true }) image?: string; // Category image URL
  @boolean() isActive!: boolean;
  @int() sortOrder!: number; // For custom ordering
  // @uuid() @optional() parentCategoryId?: string; // For hierarchical categories
  @date() createdAt!: Date;
  @date() updatedAt!: Date;

  // Self-referential relationship for parent category
  // @one(() => Category) @optional() parentCategory?: Category;
}
