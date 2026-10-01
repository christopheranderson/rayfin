import {
  entity,
  uuid,
  text,
  set,
  date,
  boolean,
  one,
  role,
} from '@microsoft/rayfin-core';

import { Notebook } from './Notebook.js';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Note {
  @uuid() id!: string;
  @text({ min: 1, max: 100 }) title!: string;
  @text() content!: string; // Rich text content (HTML or Markdown)
  @set('markdown', 'html', 'plaintext')
  contentType!: 'markdown' | 'html' | 'plaintext';
  @boolean() isPinned!: boolean;
  @boolean() isArchived!: boolean;
  @date() createdAt?: Date;
  @date() updatedAt?: Date;

  // Foreign key to notebook
  @uuid() notebook_id!: string;

  // Navigation property
  @one(() => Notebook) notebook?: Notebook;

  // User association via user_id populated from JWT claims (not a FK relationship)
  @uuid() user_id!: string;
}
