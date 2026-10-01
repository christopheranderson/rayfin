import { getFieldConstraints, toStandardSchema } from '@microsoft/rayfin-core';
import { useEffect, useMemo, useState } from 'react';

import { Note } from '../../rayfin/data/Note';
import type { Notebook } from '../../rayfin/data/Notebook';

interface NoteEditorProps {
  note: Note | null;
  notebooks: Notebook[];
  notebooksLoading: boolean;
  selectedNotebookId?: string | null;
  onSave: (noteData: Partial<Note>) => void;
  onCancel: () => void;
  onCreateNotebook?: () => Promise<void> | void;
}

export function NoteEditor({
  note,
  notebooks,
  notebooksLoading,
  selectedNotebookId,
  onSave,
  onCancel,
  onCreateNotebook,
}: NoteEditorProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [notebookId, setNotebookId] = useState('');
  const [contentType] = useState<'markdown'>('markdown');
  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const noteInputSchema = useMemo(
    () =>
      toStandardSchema(Note, {
        omit: ['createdAt', 'updatedAt', 'user_id'] as const,
      }),
    []
  );

  const titleConstraints = getFieldConstraints(Note, 'title');
  const titleMaxLength =
    titleConstraints?.type === 'string' ? titleConstraints.max : undefined;

  useEffect(() => {
    if (note) {
      setTitle(note.title);
      setContent(note.content);
      setNotebookId(note.notebook_id);
    } else {
      setTitle('');
      setContent('');
      setNotebookId(
        selectedNotebookId ||
          notebooks.find((nb) => nb.isDefault)?.id ||
          notebooks[0]?.id ||
          ''
      );
    }
  }, [note, notebooks, selectedNotebookId]);

  const handleSave = async () => {
    const noteData: Partial<Note> = {
      title: title.trim() || 'Untitled',
      content,
      contentType,
      notebook_id: notebookId,
    };

    const candidate = {
      title: noteData.title!,
      content: noteData.content!,
      contentType: noteData.contentType!,
      isPinned: note?.isPinned ?? false,
      isArchived: note?.isArchived ?? false,
      notebook_id: noteData.notebook_id!,
    };

    const result = noteInputSchema.validate(candidate);
    if (result.issues) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.issues) {
        const key = String(issue.path?.[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});

    if (!note) {
      // New note
      onSave({
        ...noteData,
        isPinned: false,
        isArchived: false,
      });
    } else {
      // Update existing note
      onSave(noteData);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
  };

  const isNewNote = !note;
  const hasNotebooks = notebooks.length > 0;

  const handleCreateNotebook = async () => {
    if (!onCreateNotebook) return;
    try {
      setCreatingNotebook(true);
      await onCreateNotebook();
    } catch (err) {
      console.error('Failed to create notebook:', err);
    } finally {
      setCreatingNotebook(false);
    }
  };

  if (isNewNote && notebooksLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center text-gray-500">
          <p>Loading notebooks...</p>
        </div>
      </div>
    );
  }

  if (isNewNote && !notebooksLoading && !hasNotebooks) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center text-gray-500 max-w-sm px-4">
          <p className="font-medium text-gray-700 mb-2">No notebooks found</p>
          <p className="text-sm text-gray-500 mb-4">
            Add a notebook to start creating notes. Notebooks organize your
            notes and are required for new notes.
          </p>
          {onCreateNotebook && (
            <button
              onClick={handleCreateNotebook}
              disabled={creatingNotebook}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-md transition-colors"
            >
              {creatingNotebook ? 'Creating...' : 'Create notebook'}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-white" onKeyDown={handleKeyDown}>
      {/* Editor Header */}
      <div className="border-b border-gray-200 p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {note ? 'Edit Note' : 'New Note'}
          </h2>
          <div className="flex space-x-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isNewNote && !hasNotebooks}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
            >
              Save
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="title"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Title
              {titleMaxLength !== undefined && (
                <span className="ml-2 text-xs text-gray-400">
                  ({title.length}/{titleMaxLength})
                </span>
              )}
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter note title..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {errors.title && (
              <p className="mt-1 text-sm text-red-600">{errors.title}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="notebook"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Notebook
            </label>
            <select
              id="notebook"
              value={notebookId}
              onChange={(e) => setNotebookId(e.target.value)}
              disabled={!hasNotebooks}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {notebooks.map((notebook) => (
                <option key={notebook.id} value={notebook.id}>
                  {notebook.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Editor Content */}
      <div className="flex-1 p-4">
        <div className="h-full">
          <label
            htmlFor="content"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Content (Markdown supported)
          </label>
          <textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Start writing your note..."
            className="w-full h-full resize-none border border-gray-300 rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
            style={{ minHeight: '400px' }}
          />
        </div>
      </div>

      {/* Keyboard Shortcuts Help */}
      <div className="border-t border-gray-200 p-2 bg-gray-50">
        <p className="text-xs text-gray-500 text-center">
          Press{' '}
          <kbd className="px-1 py-0.5 bg-gray-200 rounded text-xs">Ctrl+S</kbd>{' '}
          to save
        </p>
      </div>
    </div>
  );
}
