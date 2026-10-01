import { IStorageService } from '../interfaces/IStorageService';
import {
  ITodoAttachmentService,
  TodoAttachmentUpload,
} from '../interfaces/ITodoAttachmentService';

export class MockTodoAttachmentService implements ITodoAttachmentService {
  private readonly storageKey = 'todo_app_attachments';

  constructor(private storage: IStorageService) {}

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

    const attachment: TodoAttachmentUpload = {
      todoId,
      name: file.name,
      path: `todos/${todoId}/${file.name}`,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    };
    const attachments =
      this.storage.get<Record<string, TodoAttachmentUpload[]>>(
        this.storageKey
      ) ?? {};
    attachments[todoId] = [...(attachments[todoId] ?? []), attachment];
    this.storage.set(this.storageKey, attachments);

    return attachment;
  }
}
