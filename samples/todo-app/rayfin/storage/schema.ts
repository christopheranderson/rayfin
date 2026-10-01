import { ProfileImage } from './ProfileImage.js';
import { SharedExport } from './SharedExport.js';
import { TeamDocument } from './TeamDocument.js';
import { TodoAttachment } from './TodoAttachment.js';
import { VoiceMemo } from './VoiceMemo.js';

/**
 * Maps each storage folder name to its `@blob` class. The `StorageObjectRef`
 * envelope is added by the client automatically — write just the class, never
 * `StorageObjectRef & ProfileImage`.
 */
export type TodoAppStorageSchema = {
  ProfileImage: ProfileImage;
  TodoAttachment: TodoAttachment;
  SharedExport: SharedExport;
  TeamDocument: TeamDocument;
  VoiceMemo: VoiceMemo;
};

export const schema = [
  ProfileImage,
  TodoAttachment,
  SharedExport,
  TeamDocument,
  VoiceMemo,
];
