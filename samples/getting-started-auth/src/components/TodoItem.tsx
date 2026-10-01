import { CheckCircle2Icon, CircleIcon } from 'lucide-react';

import type { TodoWithAction } from '@/hooks/useTodos';

interface TodoItemProps {
  todo: TodoWithAction;
  onToggle: (id: string, isCompleted: boolean) => void;
  actionLabel?: string;
  actionUrl?: string;
  isHighlighted?: boolean;
  isLocked?: boolean;
}

function formatTitle(title: string) {
  const codeMatch = title.match(/^(.+?)(npx rayfin up)(.+)$/);
  if (codeMatch) {
    return (
      <>
        {codeMatch[1]}
        <code className="bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded text-sm font-mono">
          {codeMatch[2]}
        </code>
        {codeMatch[3]}
      </>
    );
  }
  return title;
}

export function TodoItem({
  todo,
  onToggle,
  actionLabel,
  actionUrl,
  isHighlighted,
  isLocked,
}: TodoItemProps) {
  return (
    <div
      className={`flex items-start gap-4 p-6 rounded-3xl border transition-all duration-300 ${
        todo.isCompleted
          ? 'bg-gray-100 border-gray-200'
          : isLocked
            ? 'bg-gray-50 border-gray-100 opacity-50'
            : isHighlighted
              ? 'bg-white border-2 border-blue-500 shadow-lg hover:shadow-xl'
              : 'bg-white border-gray-200'
      }`}
    >
      <div className="flex-1 flex flex-col">
        <button
          type="button"
          className={`text-left ${isLocked ? 'cursor-default' : ''}`}
          onClick={() => !isLocked && onToggle(todo.id, !todo.isCompleted)}
          disabled={isLocked}
        >
          <h3
            className={`text-lg ${
              todo.isCompleted
                ? 'text-gray-400 line-through'
                : isLocked
                  ? 'text-gray-400'
                  : 'text-gray-900'
            }`}
          >
            {formatTitle(todo.title)}
          </h3>
        </button>
        {actionLabel &&
          actionUrl &&
          !todo.isCompleted &&
          (isLocked ? (
            <span className="self-start mt-3 px-4 py-2 bg-gray-300 text-white rounded-lg cursor-not-allowed">
              {actionLabel}
            </span>
          ) : (
            <a
              href={actionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="self-start mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              onClick={() => onToggle(todo.id, true)}
            >
              {actionLabel}
            </a>
          ))}
      </div>
      <button
        type="button"
        className={`flex-shrink-0 mt-1 ${isLocked ? 'cursor-default' : ''}`}
        onClick={() => !isLocked && onToggle(todo.id, !todo.isCompleted)}
        disabled={isLocked}
      >
        {todo.isCompleted ? (
          <CheckCircle2Icon className="w-6 h-6 text-green-500" />
        ) : (
          <CircleIcon
            className={`w-6 h-6 ${isLocked ? 'text-gray-200' : 'text-gray-300'}`}
          />
        )}
      </button>
    </div>
  );
}
