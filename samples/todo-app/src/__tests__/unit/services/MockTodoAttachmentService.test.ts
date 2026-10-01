import { beforeEach, describe, expect, it } from 'vitest';

import { LocalStorageService } from '../../../services/mock/LocalStorageService';
import { MockTodoAttachmentService } from '../../../services/mock/MockTodoAttachmentService';

describe('MockTodoAttachmentService', () => {
  let service: MockTodoAttachmentService;

  beforeEach(() => {
    localStorage.clear();
    service = new MockTodoAttachmentService(new LocalStorageService());
  });

  it('uploads an attachment associated with its todo', async () => {
    const file = new File(['attachment'], 'requirements.txt', {
      type: 'text/plain',
    });

    await expect(
      service.uploadTodoAttachment('todo-123', file)
    ).resolves.toEqual({
      todoId: 'todo-123',
      name: 'requirements.txt',
      path: 'todos/todo-123/requirements.txt',
      contentType: 'text/plain',
      size: file.size,
    });
  });

  it('rejects an upload without a todo ID', async () => {
    const file = new File(['attachment'], 'requirements.txt');

    await expect(service.uploadTodoAttachment(' ', file)).rejects.toThrow(
      'Todo ID is required'
    );
  });
});
