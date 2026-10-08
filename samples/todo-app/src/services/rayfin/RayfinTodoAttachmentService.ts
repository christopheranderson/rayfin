import type { RayfinClient } from '@microsoft/rayfin-client';
import { StorageClient } from '@microsoft/rayfin-storage';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';
import {
  ITodoAttachmentService,
  TodoAttachmentUpload,
} from '../interfaces/ITodoAttachmentService';

import { getRayfinClient } from './RayfinClientService';

/** Rayfin storage implementation for todo attachments. */
export class RayfinTodoAttachmentService implements ITodoAttachmentService {
  private rayfinClient: RayfinClient<TodoAppSchema> & {
    storage: StorageClient<TodoAppStorageSchema>;
  };

  constructor() {
    this.rayfinClient = getRayfinClient();
  }

  async uploadTodoAttachment(
    todoId: string,
    file: File
  ): Promise<TodoAttachmentUpload> {
    if (!todoId.trim()) {
      throw new Error('Todo ID is required');
    }
    if (!file.name) {
      throw new Error('Attachment file name is required');
    }

    const prefix = `todos/${todoId}`;
    const contentType = file.type || 'application/octet-stream';
    const result = await this.rayfinClient.storage.TodoAttachment.upload(
      file.name,
      file,
      {
        prefix,
        contentType,
        fields: { todo_id: todoId },
      }
    );

    return {
      todoId,
      name: result.object.name,
      path: result.object.path,
      contentType,
      size: result.object.size,
    };
  }
}
