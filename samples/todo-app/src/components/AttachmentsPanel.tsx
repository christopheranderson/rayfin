import { useState } from 'react';

import { useTodos } from '../hooks/useTodos';
import { ServiceContainer } from '../services/ServiceContainer';

import { TodoAttachmentPicker } from './TodoAttachmentPicker';

export function AttachmentsPanel() {
  const { allTodos, loading, error } = useTodos();
  const [todoId, setTodoId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState<string>();
  const [uploadError, setUploadError] = useState<string>();

  const handleUpload = async () => {
    if (!todoId || files.length === 0) return;

    setIsUploading(true);
    setMessage(undefined);
    setUploadError(undefined);

    const results = await Promise.allSettled(
      files.map((file) =>
        ServiceContainer.create().todoAttachmentService.uploadTodoAttachment(
          todoId,
          file
        )
      )
    );
    const failedFiles = files.filter(
      (_, index) => results[index].status === 'rejected'
    );
    const uploadedCount = files.length - failedFiles.length;

    setFiles(failedFiles);
    setIsUploading(false);
    if (uploadedCount > 0) {
      setMessage(
        `${uploadedCount} attachment${uploadedCount === 1 ? '' : 's'} uploaded`
      );
    }
    if (failedFiles.length > 0) {
      setUploadError(
        `${failedFiles.length} attachment upload${failedFiles.length === 1 ? '' : 's'} failed. Try again.`
      );
    }
  };

  if (loading) {
    return <p className="py-12 text-center text-gray-500">Loading todos...</p>;
  }

  if (error) {
    return (
      <p className="rounded border border-red-200 bg-red-50 px-4 py-3 text-red-700">
        {error}
      </p>
    );
  }

  return (
    <section aria-labelledby="attachments-heading" className="space-y-6">
      <div>
        <h2
          id="attachments-heading"
          className="text-2xl font-bold text-gray-900"
        >
          Todo Attachments
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Choose a todo, then add one or more files.
        </p>
      </div>

      {allTodos.length === 0 ? (
        <p className="rounded border border-gray-200 bg-white px-4 py-8 text-center text-gray-500">
          Create a todo before uploading attachments.
        </p>
      ) : (
        <div className="space-y-5 rounded-lg border bg-white p-6 shadow">
          <div>
            <label
              htmlFor="attachment-todo"
              className="block text-sm font-medium text-gray-700"
            >
              Todo
            </label>
            <select
              id="attachment-todo"
              value={todoId}
              disabled={isUploading}
              onChange={(event) => {
                setTodoId(event.target.value);
                setMessage(undefined);
                setUploadError(undefined);
              }}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
            >
              <option value="">Select a todo</option>
              {allTodos.map((todo) => (
                <option key={todo.id} value={todo.id}>
                  {todo.Title}
                </option>
              ))}
            </select>
          </div>

          <TodoAttachmentPicker
            files={files}
            disabled={isUploading}
            onChange={setFiles}
          />

          <button
            type="button"
            disabled={!todoId || files.length === 0 || isUploading}
            onClick={handleUpload}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isUploading ? 'Uploading...' : 'Upload attachments'}
          </button>

          {message ? (
            <p className="text-sm text-green-700" role="status">
              {message}
            </p>
          ) : null}
          {uploadError ? (
            <p className="text-sm text-red-700" role="alert">
              {uploadError}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
