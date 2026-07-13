import type { Todo } from '@workspace-todo-app/data';
import { CheckCircle2Icon, CircleIcon, Trash2Icon } from 'lucide-react';

interface TodoItemProps {
  todo: Todo;
  onToggle: (id: string, isCompleted: boolean) => void;
  onDelete: (id: string) => void;
}

const PRIORITY_STYLES: Record<Todo['priority'], string> = {
  low: 'bg-green-100 text-green-700',
  medium: 'bg-amber-100 text-amber-700',
  high: 'bg-red-100 text-red-700',
};

export function TodoItem({ todo, onToggle, onDelete }: TodoItemProps) {
  return (
    <div
      className={`flex items-center gap-4 p-4 rounded-2xl border transition-all ${
        todo.isCompleted
          ? 'bg-gray-50 border-gray-200'
          : 'bg-white border-gray-200 hover:shadow-sm'
      }`}
    >
      <button
        type="button"
        aria-label={todo.isCompleted ? 'Mark incomplete' : 'Mark complete'}
        className="flex-shrink-0"
        onClick={() => onToggle(todo.id, !todo.isCompleted)}
      >
        {todo.isCompleted ? (
          <CheckCircle2Icon className="w-6 h-6 text-green-500" />
        ) : (
          <CircleIcon className="w-6 h-6 text-gray-300" />
        )}
      </button>

      <div className="flex-1 min-w-0">
        <h3
          className={`text-base truncate ${
            todo.isCompleted ? 'text-gray-400 line-through' : 'text-gray-900'
          }`}
        >
          {todo.Title}
        </h3>
        {todo.description && (
          <p className="text-sm text-gray-500 truncate">{todo.description}</p>
        )}
      </div>

      <span
        className={`flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_STYLES[todo.priority]}`}
      >
        {todo.priority}
      </span>

      <button
        type="button"
        aria-label="Delete task"
        className="flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors"
        onClick={() => onDelete(todo.id)}
      >
        <Trash2Icon className="w-5 h-5" />
      </button>
    </div>
  );
}
