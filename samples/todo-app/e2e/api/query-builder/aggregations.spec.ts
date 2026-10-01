import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext } from './setup';

/**
 * E2E coverage for the type-safe GraphQL aggregation API
 * (`groupBy` + `sum`/`avg`/`min`/`max`/`count`).
 *
 * Seed data (all owned by the freshly created test user, so RLS scopes
 * every aggregation to just these rows):
 *
 * | priority | points |
 * | -------- | ------ |
 * | high     |     10 |
 * | high     |     20 |
 * | medium   |     30 |
 * | medium   |     40 |
 * | low      |     50 |
 *
 * Grand totals: sum=150, avg=30, min=10, max=50, count=5.
 */
describe('Query Builder E2E - Aggregations', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    const seeds: Array<{
      priority: 'low' | 'medium' | 'high';
      points: number;
    }> = [
      { priority: 'high', points: 10 },
      { priority: 'high', points: 20 },
      { priority: 'medium', points: 30 },
      { priority: 'medium', points: 40 },
      { priority: 'low', points: 50 },
    ];

    for (const [index, seed] of seeds.entries()) {
      const todo = await createTodoWithNullableDescription(client, userId, {
        Title: `Aggregation Todo ${index}`,
        priority: seed.priority,
        points: seed.points,
      });
      createdIds.push(todo.id);
    }
  });

  afterAll(async () => {
    try {
      await deleteTodos(client, createdIds);
    } catch (error) {
      console.warn(
        `⚠️  Failed to delete aggregation test rows during cleanup: ${(error as Error).message}`
      );
    } finally {
      await cleanup();
    }
  });

  it('computes a grand-total sum', async () => {
    const rows = await client.data.Todo.where({ id: { in: createdIds } })
      .aggregate({ total: { sum: 'points' } })
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual({});
    expect(rows[0].aggregations.total).toBe(150);
  });

  it('computes grand-total avg, min, max, and count together', async () => {
    const rows = await client.data.Todo.where({ id: { in: createdIds } })
      .aggregate({
        average: { avg: 'points' },
        lowest: { min: 'points' },
        highest: { max: 'points' },
        n: { count: 'points' },
      })
      .execute();

    expect(rows).toHaveLength(1);
    const { aggregations } = rows[0];
    expect(aggregations.average).toBe(30);
    expect(aggregations.lowest).toBe(10);
    expect(aggregations.highest).toBe(50);
    expect(aggregations.n).toBe(5);
  });

  it('groups by priority with per-group sum and count', async () => {
    const rows = await client.data.Todo.where({ id: { in: createdIds } })
      .groupBy(['priority'])
      .aggregate({
        total: { sum: 'points' },
        n: { count: 'points' },
      })
      .execute();

    expect(rows).toHaveLength(3);

    const byPriority = new Map(
      rows.map((row) => [row.fields.priority, row.aggregations])
    );

    expect(byPriority.get('high')).toEqual({ total: 30, n: 2 });
    expect(byPriority.get('medium')).toEqual({ total: 70, n: 2 });
    expect(byPriority.get('low')).toEqual({ total: 50, n: 1 });
  });

  it('respects a where filter before aggregating', async () => {
    const rows = await client.data.Todo.where({
      id: { in: createdIds },
      priority: { neq: 'low' },
    })
      .aggregate({ total: { sum: 'points' } })
      .execute();

    expect(rows).toHaveLength(1);
    // high (10 + 20) + medium (30 + 40) = 100; low (50) excluded.
    expect(rows[0].aggregations.total).toBe(100);
  });
});
