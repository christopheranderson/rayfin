import { entity, role, uuid, text } from '@microsoft/rayfin-core';

// An example of a "reusable" entity in a shared library

@entity()
@role('authenticated', '*')
export class Image {
  @uuid() id!: string;
  @text() todoId!: string;
  @text() base64!: string;
  @text({ optional: true }) mimeType?: string;
  @text() user_id!: string;
}
