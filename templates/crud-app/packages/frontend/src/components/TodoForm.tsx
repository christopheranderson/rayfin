import { getFieldConstraints, toStandardSchema } from '@microsoft/rayfin-core';
import { Todo } from '@workspace-todo-app/data';
import { PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

interface TodoFormProps {
  onAdd: (title: string) => Promise<void>;
}

export function TodoForm({ onAdd }: TodoFormProps) {
  const [title, setTitle] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState('');

  // Build a Standard Schema for just the `Title` field straight from the Todo
  // entity, so client-side validation always matches the backend constraints.
  const titleSchema = useMemo(
    () =>
      toStandardSchema(Todo, {
        omit: [
          'id',
          'description',
          'isCompleted',
          'priority',
          'dueDate',
          'points',
          'percentComplete',
          'createdAt',
          'updatedAt',
          'category',
          'user_id',
        ] as const,
      }),
    []
  );

  const titleConstraints = getFieldConstraints(Todo, 'Title');
  const maxLength =
    titleConstraints?.type === 'string' ? titleConstraints.max : undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = titleSchema.validate({ Title: title.trim() });

    if (result.issues) {
      setError(result.issues[0].message);
      return;
    }
    setError('');

    setIsAdding(true);
    try {
      await onAdd(result.value.Title);
      setTitle('');
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-1">
      <div className="flex gap-2 items-center">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Add new item"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isAdding}
            className="w-full px-4 py-3 border border-gray-200 rounded-xl text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {maxLength !== undefined && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
              {title.length}/{maxLength}
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={isAdding}
          className="flex-shrink-0 w-10 h-10 bg-blue-600 text-white rounded-xl flex items-center justify-center hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <PlusIcon className="w-5 h-5" />
        </button>
      </div>
      {error && <p className="text-sm text-red-600 px-1">{error}</p>}
    </form>
  );
}
