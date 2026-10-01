import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';
import { getBackendUrl } from '../../shared/backend';

import { createTodoWithNullableDescription, deleteTodos } from './fixtures';
import { createQueryBuilderTestContext, getDialect } from './setup';

// Evaluate at module load time so conditional test runs work correctly
const isPostgres = getDialect() === 'postgresql';

describe('Query Builder E2E - Error Propagation', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  const testDate = new Date('2024-06-15T12:00:00.000Z');

  beforeAll(async () => {
    const context = await createQueryBuilderTestContext();
    client = context.client;
    userId = context.userId;
    cleanup = context.cleanup;

    // Create a test todo with a date
    const todo = await createTodoWithNullableDescription(client, userId, {
      Title: 'Error Propagation Test Todo',
      points: 1,
      dueDate: testDate,
      createdAt: testDate,
      updatedAt: testDate,
    });
    createdIds.push(todo.id);
  });

  afterAll(async () => {
    await deleteTodos(client, createdIds);
    await cleanup();
  });

  it.runIf(isPostgres)(
    'DAB date comparison resolves on PostgreSQL',
    async () => {
      // DAB 2.0.10 supports date comparison operators (gte, gt, lt, lte) on
      // PostgreSQL. A gte comparison against the seeded todo's dueDate resolves
      // and returns the matching record instead of raising a DAB error.
      const results = await client.data.Todo.select(['id', 'dueDate', 'Title'])
        .where({ dueDate: { gte: testDate } })
        .execute();

      expect(results.some((todo) => todo.id === createdIds[0])).toBe(true);
    }
  );

  it('invalid GraphQL query syntax propagates error to client', async () => {
    // Malformed GraphQL should return an error that propagates to the client
    const baseUrl = getBackendUrl();

    const publishableKey = await fetch(`${baseUrl}/api/publishable-key`, {
      method: 'GET',
    })
      .then((res) => res.json())
      .then((data) => data.publishableKey);

    // Send a raw GraphQL request with invalid syntax to test error propagation
    const response = await fetch(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Publishable-Key': publishableKey,
      },
      body: JSON.stringify({
        query: `
          query {
            todos(first: 10) {
              items {
                  invalid
              }
            }
          }
        `,
      }),
    });

    // Verify the response has the correct content type for GraphQL
    expect(response.headers.get('content-type')).toContain('application/json');

    // Parse the response to check for errors
    const data = await response.json();

    // Server should return errors for invalid syntax
    expect(data.errors).toBeDefined();
    expect(data.errors.length).toEqual(1);

    const error = data.errors[0];
    expect(error.message).toEqual(
      'The field `invalid` does not exist on the type `Todo`.'
    );

    // HC handles this error directly — verify standard GraphQL error properties are preserved
    // locations indicates where in the query the error occurred (line/column)
    expect(error.locations).toBeDefined();
    expect(error.locations.length).toBeGreaterThan(0);
    expect(error.locations[0]).toHaveProperty('line');
    expect(error.locations[0]).toHaveProperty('column');

    // extensions contains HC error metadata (e.g. error code)
    expect(error.extensions).toBeDefined();
    expect(error.extensions.field).toBeDefined();
    expect(error.extensions.field).toEqual('invalid');
    expect(error.extensions.type).toBeDefined();
    expect(error.extensions.type).toEqual('Todo');
    expect(error.extensions.responseName).toBeDefined();
    expect(error.extensions.responseName).toEqual('invalid');
    expect(error.extensions.specifiedBy).toBeDefined();
    expect(error.extensions.specifiedBy).toEqual(
      'https://spec.graphql.org/September2025/#sec-Field-Selections'
    );
    // HotChocolate 16 no longer attaches a `path` to pre-execution field-selection
    // validation errors (path is a runtime execution concept surfaced only during
    // execution); earlier versions included ['todos', 'items'].
    expect(error.path).toBeUndefined();
  });
});
