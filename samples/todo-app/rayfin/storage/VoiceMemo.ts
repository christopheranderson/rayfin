import { role, text } from '@microsoft/rayfin-core';
import { blob, ContentTypes } from '@microsoft/rayfin-core/experimental';

/** Voice memos on a todo: audio only, max 5 MB (size string). */
@blob({
  name: 'voice-memos',
  maxSize: '5mb',
  allowedContentTypes: [ContentTypes.AnyAudio],
})
@role('authenticated', '*')
export class VoiceMemo {
  @text() todo_id!: string;
  @text() transcription!: string;
}
