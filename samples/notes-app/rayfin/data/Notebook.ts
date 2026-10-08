import {
  entity,
  uuid,
  text,
  date,
  many,
  boolean,
  role,
} from '@microsoft/rayfin-core';

import { Note } from './Note.js';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Notebook {
  @uuid() id!: string;
  @text({ min: 1, max: 50 }) name!: string;
  @text() description?: string;
  @text() color?: string; // Hex color for visual organization
  @boolean() isDefault!: boolean; // Each user has one default notebook
  @date() createdAt?: Date;
  @date() updatedAt?: Date;

  // Navigation property
  @many(() => Note) notes?: Note[];
  // User association via user_id populated from JWT claims (not a FK relationship)
  @uuid() user_id!: string;
}
