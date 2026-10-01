export interface TodoAttachmentUpload {
  todoId: string;
  name: string;
  path: string;
  contentType: string;
  size: number;
}

/** Uploads files associated with a todo. */
export interface ITodoAttachmentService {
  uploadTodoAttachment(
    todoId: string,
    file: File
  ): Promise<TodoAttachmentUpload>;
}
