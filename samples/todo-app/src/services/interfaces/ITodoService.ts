import { Todo } from '../../../rayfin/data/Todo';

/**
 * Scalar field of Todo that a grouped aggregation can group over.
 *
 * `'none'` produces a single grand-total row (no grouping).
 */
export type TodoGroupByField = 'priority' | 'isCompleted' | 'none';

/**
 * Options that toggle the optional aggregation conditions so every DAB
 * aggregation code path can be exercised from the UI.
 */
export interface TodoAggregationOptions {
  /** When set, adds a `having` filter: keep groups whose `sum(points)` is \>= this value. */
  havingSumPointsGte?: number;
  /** When true, the `count` aggregation counts distinct `points` values only. */
  distinctCount?: boolean;
}

/**
 * One grouped aggregation row returned by {@link ITodoService.aggregateTodos}.
 *
 * `sum`/`avg`/`min`/`max` are `number | null` because DAB returns `NULL` over
 * empty or all-null groups; `count` is always a `number`.
 */
export interface TodoAggregationRow {
  /** The grouping key values for this row (empty for the grand-total row). */
  group: Record<string, string | number | boolean | null>;
  sumPoints: number | null;
  avgPercentComplete: number | null;
  minPoints: number | null;
  maxPoints: number | null;
  countPoints: number;
  /** Aggregation over the nullable `optionalPoints` field. */
  sumOptionalPoints: number | null;
}

export interface ITodoService {
  getTodos(): Promise<Todo[]>;
  getTodoById(id: string): Promise<Todo | null>;
  createTodo(todo: Omit<Todo, 'id' | 'createdAt' | 'updatedAt'>): Promise<Todo>;
  updateTodo(
    id: string,
    updates: Partial<Omit<Todo, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<Todo>;
  deleteTodo(id: string): Promise<void>;
  /**
   * Run a grouped aggregation over the current user's todos.
   *
   * @param groupBy - The field to group by, or `'none'` for a grand total.
   * @param options - Optional `having` / `distinct` conditions.
   * @returns One row per group (or a single grand-total row).
   */
  aggregateTodos(
    groupBy: TodoGroupByField,
    options?: TodoAggregationOptions
  ): Promise<TodoAggregationRow[]>;
}
