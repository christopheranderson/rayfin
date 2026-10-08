import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext } from './setup';

/*
 * Advanced E2E coverage for the type-safe GraphQL aggregation API, exercising
 * the scenarios the base aggregations.spec.ts suite does not:
 *
 * - the object/options operand form (`{ field, having?, distinct? }`) end-to-end,
 * - `having` filters that change the returned row set,
 * - `distinct` counts,
 * - `NULL` semantics over all-null groups and empty result sets,
 * - fractional `avg` over a decimal field,
 * - per-group `min`/`max`,
 * - multi-field `groupBy`.
 *
 * Seed data (all owned by the freshly created test user, so RLS scopes every
 * aggregation to just these rows):
 *
 * | label | priority | isCompleted | points | optionalPoints | percentComplete |
 * | ----- | -------- | ----------- | ------ | -------------- | --------------- |
 * | A     | high     | false       |     10 |              5 |            10.5 |
 * | B     | high     | false       |     10 |         (null) |            20.5 |
 * | C     | high     | true        |     15 |              5 |            30.0 |
 * | D     | medium   | false       |     30 |         (null) |             0.0 |
 * | E     | medium   | false       |     40 |         (null) |             0.0 |
 * | F     | low      | false       |     50 |             20 |             0.0 |
 *
 * Derived expectations:
 * - points: sum=155, count=6, distinct=5 (two 10s collapse).
 * - optionalPoints: non-null count=3 (A, C, F), distinct=2 ({5, 20}).
 * - per-priority points: high={10,10,15}, medium={30,40}, low={50}.
 */
describe('Query Builder E2E - Aggregation advanced scenarios', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];
  const idByLabel = new Map<string, string>();

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    const seeds: Array<{
      label: string;
      priority: 'low' | 'medium' | 'high';
      isCompleted: boolean;
      points: number;
      optionalPoints?: number;
      percentComplete: number;
    }> = [
      {
        label: 'A',
        priority: 'high',
        isCompleted: false,
        points: 10,
        optionalPoints: 5,
        percentComplete: 10.5,
      },
      {
        label: 'B',
        priority: 'high',
        isCompleted: false,
        points: 10,
        percentComplete: 20.5,
      },
      {
        label: 'C',
        priority: 'high',
        isCompleted: true,
        points: 15,
        optionalPoints: 5,
        percentComplete: 30,
      },
      {
        label: 'D',
        priority: 'medium',
        isCompleted: false,
        points: 30,
        percentComplete: 0,
      },
      {
        label: 'E',
        priority: 'medium',
        isCompleted: false,
        points: 40,
        percentComplete: 0,
      },
      {
        label: 'F',
        priority: 'low',
        isCompleted: false,
        points: 50,
        optionalPoints: 20,
        percentComplete: 0,
      },
    ];

    for (const seed of seeds) {
      const todo = await createTodoWithNullableDescription(client, userId, {
        Title: `Advanced Aggregation Todo ${seed.label}`,
        priority: seed.priority,
        isCompleted: seed.isCompleted,
        points: seed.points,
        optionalPoints: seed.optionalPoints,
        percentComplete: seed.percentComplete,
      });
      createdIds.push(todo.id);
      idByLabel.set(seed.label, todo.id);
    }
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  it('object form: having filter narrows the returned groups', async () => {
    const rows = await client.data.Todo.where({ id: { in: createdIds } })
      .groupBy(['priority'])
      .aggregate({
        total: { sum: { field: 'points', having: { gt: 40 } } },
      })
      .execute();

    // high sums to 35 and is filtered out; medium (70) and low (50) remain.
    const byPriority = new Map(
      rows.map((row) => [row.fields.priority, row.aggregations.total])
    );

    expect(rows).toHaveLength(2);
    expect(byPriority.get('medium')).toBe(70);
    expect(byPriority.get('low')).toBe(50);
    expect(byPriority.has('high')).toBe(false);
  });

  it('object form: distinct count collapses duplicate values', async () => {
    const rows = await client.data.Todo.where({ id: { in: createdIds } })
      .aggregate({
        n: { count: 'points' },
        nDistinct: { count: { field: 'points', distinct: true } },
        optNonNull: { count: 'optionalPoints' },
        optDistinct: { count: { field: 'optionalPoints', distinct: true } },
      })
      .execute();

    expect(rows).toHaveLength(1);
    const { aggregations } = rows[0];
    expect(aggregations.n).toBe(6);
    expect(aggregations.nDistinct).toBe(5); // two points=10 rows collapse
    expect(aggregations.optNonNull).toBe(3); // A, C, F; nulls excluded
    expect(aggregations.optDistinct).toBe(2); // {5, 20}
  });

  it('returns null for sum/avg/min/max over an all-null group', async () => {
    const rows = await client.data.Todo.where({ id: { in: createdIds } })
      .groupBy(['priority'])
      .aggregate({
        optSum: { sum: 'optionalPoints' },
        optAvg: { avg: 'optionalPoints' },
        optMin: { min: 'optionalPoints' },
        optMax: { max: 'optionalPoints' },
      })
      .execute();

    const byPriority = new Map(
      rows.map((row) => [row.fields.priority, row.aggregations])
    );

    // medium (D, E) has only null optionalPoints -> every op is null.
    expect(byPriority.get('medium')).toEqual({
      optSum: null,
      optAvg: null,
      optMin: null,
      optMax: null,
    });

    // low (F) has a single non-null value of 20.
    const low = byPriority.get('low')!;
    expect(low.optSum).toBe(20);
    expect(low.optMin).toBe(20);
    expect(low.optMax).toBe(20);
  });

  it('returns a single grand-total row with null sum and zero count over an empty match set', async () => {
    const rows = await client.data.Todo.where({
      id: { in: createdIds },
      points: { gt: 1000 },
    })
      .aggregate({
        total: { sum: 'points' },
        n: { count: 'points' },
      })
      .execute();

    // A grand-total aggregate (no groupBy) over zero matching rows still
    // returns one row: sum of an empty set is null, count is 0.
    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual({});
    expect(rows[0].aggregations.total).toBeNull();
    expect(rows[0].aggregations.n).toBe(0);
  });

  it('computes a fractional avg over a decimal field', async () => {
    const rows = await client.data.Todo.where({
      id: { in: [idByLabel.get('A')!, idByLabel.get('B')!] },
    })
      .aggregate({ avgPct: { avg: 'percentComplete' } })
      .execute();

    expect(rows).toHaveLength(1);
    // (10.5 + 20.5) / 2 = 15.5
    expect(rows[0].aggregations.avgPct).toBeCloseTo(15.5, 5);
  });

  it('computes per-group min and max', async () => {
    const rows = await client.data.Todo.where({ id: { in: createdIds } })
      .groupBy(['priority'])
      .aggregate({
        lo: { min: 'points' },
        hi: { max: 'points' },
      })
      .execute();

    const byPriority = new Map(
      rows.map((row) => [row.fields.priority, row.aggregations])
    );

    expect(byPriority.get('high')).toEqual({ lo: 10, hi: 15 });
    expect(byPriority.get('medium')).toEqual({ lo: 30, hi: 40 });
    expect(byPriority.get('low')).toEqual({ lo: 50, hi: 50 });
  });

  it('groups by multiple fields', async () => {
    const rows = await client.data.Todo.where({ id: { in: createdIds } })
      .groupBy(['priority', 'isCompleted'])
      .aggregate({
        total: { sum: 'points' },
        n: { count: 'points' },
      })
      .execute();

    const key = (priority: string, isCompleted: boolean) =>
      `${priority}:${isCompleted}`;
    const byGroup = new Map(
      rows.map((row) => [
        key(row.fields.priority, row.fields.isCompleted),
        row.aggregations,
      ])
    );

    expect(rows).toHaveLength(4);
    expect(byGroup.get(key('high', false))).toEqual({ total: 20, n: 2 });
    expect(byGroup.get(key('high', true))).toEqual({ total: 15, n: 1 });
    expect(byGroup.get(key('medium', false))).toEqual({ total: 70, n: 2 });
    expect(byGroup.get(key('low', false))).toEqual({ total: 50, n: 1 });
  });
});
