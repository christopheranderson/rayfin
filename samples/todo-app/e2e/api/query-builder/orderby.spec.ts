import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext } from './setup';

describe('Query Builder E2E - OrderBy', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    for (let i = 0; i < 5; i += 1) {
      const todo = await createTodoWithNullableDescription(client, userId, {
        Title: `OrderBy ${i}`,
        points: i + 1,
        createdAt: new Date(Date.now() + i * 1000),
        updatedAt: new Date(Date.now() + i * 1000),
      });
      createdIds.push(todo.id);
    }
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  describe('single-field directions', () => {
    it('orders by string field ascending', async () => {
      const result = await client.data.Todo.select(['id', 'Title'])
        .where({ id: { in: createdIds } })
        .orderBy({ Title: 'asc' })
        .first(5)
        .execute();

      const titles = result.map((t) => t.Title);
      const sorted = [...titles].sort();
      expect(titles).toEqual(sorted);
    });

    it('orders by string field descending', async () => {
      const result = await client.data.Todo.select(['id', 'Title'])
        .where({ id: { in: createdIds } })
        .orderBy({ Title: 'desc' })
        .first(5)
        .execute();

      const titles = result.map((t) => t.Title);
      const sorted = [...titles].sort().reverse();
      expect(titles).toEqual(sorted);
    });

    it('orders by number field ascending', async () => {
      const result = await client.data.Todo.select(['id', 'points'])
        .where({ id: { in: createdIds } })
        .orderBy({ points: 'asc' })
        .first(5)
        .execute();

      const points = result.map((t) => t.points);
      expect(points).toEqual([1, 2, 3, 4, 5]);
    });

    it('orders by number field descending', async () => {
      const result = await client.data.Todo.select(['id', 'points'])
        .where({ id: { in: createdIds } })
        .orderBy({ points: 'desc' })
        .first(5)
        .execute();

      const points = result.map((t) => t.points);
      expect(points).toEqual([5, 4, 3, 2, 1]);
    });

    it('orders by date field ascending', async () => {
      const result = await client.data.Todo.select(['id', 'Title', 'createdAt'])
        .where({ id: { in: createdIds } })
        .orderBy({ createdAt: 'asc' })
        .first(5)
        .execute();

      const titles = result.map((t) => t.Title);
      expect(titles).toEqual([
        'OrderBy 0',
        'OrderBy 1',
        'OrderBy 2',
        'OrderBy 3',
        'OrderBy 4',
      ]);
    });

    it('orders by date field descending', async () => {
      const result = await client.data.Todo.select(['id', 'Title', 'createdAt'])
        .where({ id: { in: createdIds } })
        .orderBy({ createdAt: 'desc' })
        .first(5)
        .execute();

      const titles = result.map((t) => t.Title);
      expect(titles).toEqual([
        'OrderBy 4',
        'OrderBy 3',
        'OrderBy 2',
        'OrderBy 1',
        'OrderBy 0',
      ]);
    });
  });

  describe('multi-field orderBy with collisions', () => {
    const collisionIds: string[] = [];

    beforeAll(async () => {
      // Seed todos where the primary sort field has duplicates.
      // priority has collisions: 3 "high", 2 "low"
      // points and Title break the ties.
      const seeds = [
        { Title: 'Charlie', priority: 'high' as const, points: 3 },
        { Title: 'Alpha', priority: 'high' as const, points: 1 },
        { Title: 'Bravo', priority: 'high' as const, points: 2 },
        { Title: 'Echo', priority: 'low' as const, points: 5 },
        { Title: 'Delta', priority: 'low' as const, points: 4 },
      ];

      for (const seed of seeds) {
        const todo = await createTodoWithNullableDescription(client, userId, {
          Title: seed.Title,
          priority: seed.priority,
          points: seed.points,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        collisionIds.push(todo.id);
      }
    });

    afterAll(async () => {
      await deleteTodos(client, collisionIds);
    });

    it('breaks string-field ties with number field ascending', async () => {
      // Primary: priority asc ("high" < "low"), secondary: points asc
      const result = await client.data.Todo.select([
        'id',
        'Title',
        'priority',
        'points',
      ])
        .where({ id: { in: collisionIds } })
        .orderBy({ priority: 'asc', points: 'asc' })
        .first(5)
        .execute();

      const titles = result.map((t) => t.Title);
      // high group sorted by points asc (1,2,3), then low group (4,5)
      expect(titles).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
    });

    it('breaks string-field ties with number field descending', async () => {
      // Primary: priority asc, secondary: points desc
      const result = await client.data.Todo.select([
        'id',
        'Title',
        'priority',
        'points',
      ])
        .where({ id: { in: collisionIds } })
        .orderBy({ priority: 'asc', points: 'desc' })
        .first(5)
        .execute();

      const titles = result.map((t) => t.Title);
      // high group sorted by points desc (3,2,1), then low group (5,4)
      expect(titles).toEqual(['Charlie', 'Bravo', 'Alpha', 'Echo', 'Delta']);
    });

    it('breaks ties with string field ascending as secondary sort', async () => {
      // Primary: priority desc ("low" first), secondary: Title asc
      const result = await client.data.Todo.select(['id', 'Title', 'priority'])
        .where({ id: { in: collisionIds } })
        .orderBy({ priority: 'desc', Title: 'asc' })
        .first(5)
        .execute();

      const titles = result.map((t) => t.Title);
      // low group sorted by Title asc (Delta, Echo), then high group (Alpha, Bravo, Charlie)
      expect(titles).toEqual(['Delta', 'Echo', 'Alpha', 'Bravo', 'Charlie']);
    });

    it('breaks ties with string field descending as secondary sort', async () => {
      const result = await client.data.Todo.select(['id', 'Title', 'priority'])
        .where({ id: { in: collisionIds } })
        .orderBy({ priority: 'desc', Title: 'desc' })
        .first(5)
        .execute();

      const titles = result.map((t) => t.Title);
      // low group sorted by Title desc (Echo, Delta), then high group (Charlie, Bravo, Alpha)
      expect(titles).toEqual(['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']);
    });
  });
});
