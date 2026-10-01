import { describe, it, expect, beforeEach } from 'vitest';

import { Todo } from '../../../../rayfin/data/Todo';
import { AuthUser } from '../../../models/AuthUser';
import { IAuthService } from '../../../services/interfaces/IAuthService';
import { LocalStorageService } from '../../../services/mock/LocalStorageService';
import { MockTodoService } from '../../../services/mock/MockTodoService';

const TODOS_KEY = 'todo_app_todos';
const USER_ID = 'u1';

function makeTodo(overrides: Partial<Todo>): Todo {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    Title: overrides.Title ?? 'Task',
    isCompleted: overrides.isCompleted ?? false,
    priority: overrides.priority ?? 'medium',
    points: overrides.points ?? 0,
    percentComplete: overrides.percentComplete ?? 0,
    createdAt: overrides.createdAt ?? new Date('2024-01-01'),
    updatedAt: overrides.updatedAt ?? new Date('2024-01-01'),
    user_id: overrides.user_id ?? USER_ID,
    ...overrides,
  };
}

/**
 * Fixed dataset (all owned by USER_ID unless noted) exercising every aggregate path:
 * - priority `high`: points [3, 5], optionalPoints [2, undefined], percentComplete [50, 100]
 * - priority `low`:  points [5, 3], optionalPoints [undefined, 4], percentComplete [0, 20]
 * - priority `medium`: points [0], optionalPoints [undefined], percentComplete [10]
 * - one extra todo owned by a different user, which must never appear in results.
 */
function seedDataset(): Todo[] {
  return [
    makeTodo({
      id: '1',
      priority: 'high',
      isCompleted: false,
      points: 3,
      optionalPoints: 2,
      percentComplete: 50,
    }),
    makeTodo({
      id: '2',
      priority: 'high',
      isCompleted: true,
      points: 5,
      optionalPoints: undefined,
      percentComplete: 100,
    }),
    makeTodo({
      id: '3',
      priority: 'low',
      isCompleted: false,
      points: 5,
      optionalPoints: undefined,
      percentComplete: 0,
    }),
    makeTodo({
      id: '4',
      priority: 'low',
      isCompleted: false,
      points: 3,
      optionalPoints: 4,
      percentComplete: 20,
    }),
    makeTodo({
      id: '5',
      priority: 'medium',
      isCompleted: true,
      points: 0,
      optionalPoints: undefined,
      percentComplete: 10,
    }),
    makeTodo({
      id: '6',
      priority: 'high',
      isCompleted: false,
      points: 999,
      optionalPoints: 999,
      percentComplete: 99,
      user_id: 'someone-else',
    }),
  ];
}

function createService(todos: Todo[]): MockTodoService {
  const storage = new LocalStorageService();
  // Seed before construction so the demo-data initializer is skipped.
  storage.set(TODOS_KEY, todos);

  const auth: Pick<IAuthService, 'getCurrentUser'> = {
    getCurrentUser: async (): Promise<AuthUser> => ({
      Id: USER_ID,
      Email: 'u1@test.com',
      Name: 'User One',
    }),
  };

  return new MockTodoService(storage, auth as IAuthService);
}

describe('MockTodoService.aggregateTodos', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('groups by priority and computes each aggregate', async () => {
    const service = createService(seedDataset());

    const rows = await service.aggregateTodos('priority');

    // Only the current user's three priority buckets are present.
    expect(rows).toHaveLength(3);

    const byPriority = new Map(rows.map((r) => [r.group.priority, r]));

    const high = byPriority.get('high')!;
    expect(high.sumPoints).toBe(8);
    expect(high.avgPercentComplete).toBe(75);
    expect(high.minPoints).toBe(3);
    expect(high.maxPoints).toBe(5);
    expect(high.countPoints).toBe(2);
    expect(high.sumOptionalPoints).toBe(2); // only one non-null optional value

    const low = byPriority.get('low')!;
    expect(low.sumPoints).toBe(8);
    expect(low.avgPercentComplete).toBe(10);
    expect(low.minPoints).toBe(3);
    expect(low.maxPoints).toBe(5);
    expect(low.countPoints).toBe(2);
    expect(low.sumOptionalPoints).toBe(4);

    const medium = byPriority.get('medium')!;
    expect(medium.sumPoints).toBe(0);
    expect(medium.avgPercentComplete).toBe(10);
    expect(medium.minPoints).toBe(0);
    expect(medium.maxPoints).toBe(0);
    expect(medium.countPoints).toBe(1);
    // Every optionalPoints in this bucket is undefined -> null sum.
    expect(medium.sumOptionalPoints).toBeNull();
  });

  it('groups by isCompleted with string keys', async () => {
    const service = createService(seedDataset());

    const rows = await service.aggregateTodos('isCompleted');

    const byDone = new Map(rows.map((r) => [r.group.isCompleted, r]));
    expect(rows).toHaveLength(2);

    // isCompleted=false -> todos 1, 3, 4 (points 3, 5, 3)
    expect(byDone.get('false')!.sumPoints).toBe(11);
    // isCompleted=true -> todos 2, 5 (points 5, 0)
    expect(byDone.get('true')!.sumPoints).toBe(5);
  });

  it('returns a single grand-total row with an empty group for "none"', async () => {
    const service = createService(seedDataset());

    const rows = await service.aggregateTodos('none');

    expect(rows).toHaveLength(1);
    const total = rows[0];
    expect(total.group).toEqual({});
    expect(total.sumPoints).toBe(16); // 3 + 5 + 5 + 3 + 0
    expect(total.avgPercentComplete).toBe(36); // (50+100+0+20+10)/5
    expect(total.minPoints).toBe(0);
    expect(total.maxPoints).toBe(5);
    expect(total.countPoints).toBe(5);
    expect(total.sumOptionalPoints).toBe(6); // 2 + 4
  });

  it('counts distinct points values when distinctCount is enabled', async () => {
    const service = createService(seedDataset());

    const rows = await service.aggregateTodos('none', { distinctCount: true });

    // Distinct point values across the user's todos: {3, 5, 0} -> 3
    expect(rows[0].countPoints).toBe(3);
  });

  it('excludes groups below the havingSumPointsGte threshold', async () => {
    const service = createService(seedDataset());

    // high=8, low=8, medium=0 -> threshold 8 keeps high and low.
    const kept = await service.aggregateTodos('priority', {
      havingSumPointsGte: 8,
    });
    expect(kept.map((r) => r.group.priority).sort()).toEqual(['high', 'low']);

    // threshold above every group's sum -> no rows.
    const none = await service.aggregateTodos('priority', {
      havingSumPointsGte: 9,
    });
    expect(none).toHaveLength(0);
  });

  it('excludes todos owned by other users', async () => {
    const service = createService(seedDataset());

    const rows = await service.aggregateTodos('none');

    // The 999-point todo belongs to another user and must not leak in.
    expect(rows[0].maxPoints).toBe(5);
    expect(rows[0].sumPoints).toBe(16);
  });

  it('returns no rows when the user has no todos', async () => {
    const service = createService([]);

    const grouped = await service.aggregateTodos('priority');
    expect(grouped).toHaveLength(0);

    // The grand total also yields no row when there is nothing to aggregate.
    const total = await service.aggregateTodos('none');
    expect(total).toHaveLength(0);
  });

  it('treats missing points as zero', async () => {
    const service = createService([
      makeTodo({
        id: 'a',
        priority: 'low',
        points: undefined as unknown as number,
      }),
      makeTodo({ id: 'b', priority: 'low', points: 4 }),
    ]);

    const rows = await service.aggregateTodos('none');

    expect(rows[0].sumPoints).toBe(4); // undefined -> 0, plus 4
    expect(rows[0].minPoints).toBe(0);
    expect(rows[0].maxPoints).toBe(4);
    expect(rows[0].countPoints).toBe(2);
  });

  it('returns null numeric aggregates for a single all-null optional group', async () => {
    const service = createService([
      makeTodo({
        id: 'solo',
        priority: 'high',
        points: 7,
        optionalPoints: undefined,
        percentComplete: 42,
      }),
    ]);

    const rows = await service.aggregateTodos('priority');

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sumPoints).toBe(7);
    expect(row.avgPercentComplete).toBe(42);
    expect(row.minPoints).toBe(7);
    expect(row.maxPoints).toBe(7);
    expect(row.countPoints).toBe(1);
    expect(row.sumOptionalPoints).toBeNull();
  });
});
