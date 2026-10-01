import { TodoItem } from '@/components/TodoItem';
import type { TodoWithAction } from '@/hooks/useTodos';

interface TodoListProps {
  todos: TodoWithAction[];
  loading: boolean;
  onToggle: (id: string, isCompleted: boolean) => void;
}

export function TodoList({ todos, loading, onToggle }: TodoListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        Loading tasks...
      </div>
    );
  }

  if (todos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-muted-foreground">No tasks yet.</p>
        <p className="text-sm text-muted-foreground">
          Add your first task above to get started.
        </p>
      </div>
    );
  }

  // Find the first non-completed todo to highlight
  const firstIncompleteIndex = todos.findIndex((t) => !t.isCompleted);

  return (
    <div className="space-y-4">
      {todos.map((todo, index) => (
        <TodoItem
          key={todo.id}
          todo={todo}
          onToggle={onToggle}
          isHighlighted={index === firstIncompleteIndex}
          isLocked={
            firstIncompleteIndex !== -1 &&
            index > firstIncompleteIndex &&
            !todo.isCompleted
          }
          actionLabel={todo.buttonTitle}
          actionUrl={todo.buttonUrl}
        />
      ))}
    </div>
  );
}
