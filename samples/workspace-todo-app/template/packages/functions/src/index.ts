import type { Todo } from '@workspace-todo-app/data';

/**
 * Functions schema for the workspace todo app.
 * Defines available serverless functions and their signatures.
 * Conforms to FunctionsSchema from the rayfin-functions package.
 */
export type TodoFunctionsSchema = {
  completeTodo: {
    input: { todoId: string };
    output: Todo;
  };
  healthCheck: {
    input: Record<string, never>;
    output: { ok: boolean; timestamp: string };
  };
};
