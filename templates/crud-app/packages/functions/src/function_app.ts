/**
 * Fabric User Data Functions host for the workspace todo app.
 *
 * This is the runnable Functions host that `rayfin dev functions` builds and
 * serves with `func start`. During local development the Vite proxy
 * (`@workspace-todo-app/local-dev`) auto-detects this host and routes
 * `/.rayfin/functions/<name>/invoke` here as `POST /api/<name>`; when the host
 * isn't running the same calls fall through to the deployed backend, so the
 * app code never changes between local and production.
 *
 * The function *signatures* registered here are mirrored by
 * `TodoFunctionsSchema` in `./index.ts`, which the frontend imports so that
 * `client.functions.<name>.invoke(...)` is fully typed. The generated
 * `./src/types.ts` is produced from these `udf.func()` calls by the CLI typegen
 * watcher and is not consumed by the frontend.
 */
import {
  UserDataFunctions,
  RayfinContext,
} from '@microsoft/fabric-user-data-functions';
import type { Todo, TodoAppSchema } from '@workspace-todo-app/data';

const udf = new UserDataFunctions();

/**
 * Liveness probe. Takes no input and touches no data, so it is the safest
 * end-to-end check that the local proxy to `func` host round-trip is wired up.
 */
udf.func(
  'healthCheck',
  async (): Promise<{ ok: boolean; timestamp: string }> => {
    return { ok: true, timestamp: new Date().toISOString() };
  },
  []
);

/**
 * Mark a todo complete server-side and return the updated row.
 *
 * Demonstrates a data-touching function: it uses the invocation's
 * {@link RayfinContext} to talk to the same backend the frontend uses, honoring
 * the caller's auth. `ctx` is injected by the runtime and is stripped from the
 * client-facing signature, so callers invoke it as `completeTodo({ todoId })`.
 */
udf.func(
  'completeTodo',
  async (todoId: string, ctx: RayfinContext<TodoAppSchema>): Promise<Todo> => {
    const data = ctx.getDataClient();

    await data.Todo.update(
      { id: todoId },
      { isCompleted: true, percentComplete: 100, updatedAt: new Date() }
    );

    const rows = await data.Todo.select([
      'id',
      'Title',
      'description',
      'isCompleted',
      'priority',
      'points',
      'percentComplete',
      'createdAt',
      'updatedAt',
      'user_id',
    ]).execute();

    const updated = rows.find((t) => t.id === todoId);
    if (!updated) {
      throw new Error(`Todo ${todoId} not found after completion.`);
    }
    return updated as Todo;
  },
  []
);
