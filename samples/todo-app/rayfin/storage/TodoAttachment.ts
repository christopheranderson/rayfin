import { role, text } from '@microsoft/rayfin-core';
import { blob } from '@microsoft/rayfin-core/experimental';

/** Files a user attaches to a todo, with overwrite allowed. */
@blob({ onConflict: 'overwrite' })
@role('authenticated', '*')
export class TodoAttachment {
  @text() todo_id!: string;
}
