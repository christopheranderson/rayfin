import { execSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';
import { startBackend, stopBackend } from '../../shared/backend';
import { createTestClient } from '../../shared/client-factory';
import {
  executeGraphQL,
  isFieldAbsent,
  probeEntityExists,
  probeFields,
} from '../../shared/graphql';
import { generateUniqueUser } from '../../shared/test-data';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const DATA_DIR = resolve(__dirname, '../../../rayfin/data');
const SCHEMA_PATH = resolve(DATA_DIR, 'schema.ts');
const RENAMED_ENTITY_PATH = resolve(DATA_DIR, 'ColumnMapped.ts');
const TODO_APP_DIR = resolve(__dirname, '../../..');

// Snapshot the original schema.ts so afterAll can put it back even on failure.
const ORIGINAL_SCHEMA = readFileSync(SCHEMA_PATH, 'utf-8');

const RENAMED_ENTITY_CONTENT = `import { entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ColumnMapped {
  @uuid() id!: string;
  // TS property 'foo' maps to SQL column 'Foo'. The GraphQL surface always
  // exposes the TypeScript property name ('foo') — the SQL column name never
  // leaks into the public schema.
  @text({ column: 'Foo' }) foo!: string;
  @text() user_id!: string;
}
`;

const SCHEMA_WITH_RENAMED = `import { Category } from './Category.js';
import { ColumnMapped } from './ColumnMapped.js';
import { Todo } from './Todo.js';

export type TodoAppSchema = {
  Todo: Todo;
  Category: Category;
  ColumnMapped: ColumnMapped;
};

export const schema = [Todo, Category, ColumnMapped];
`;

describe('Query Builder E2E - Column name mapping', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let userId: string;
  let accessToken: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    // Clear any leftover from a previous failed run before redeploying.
    if (existsSync(RENAMED_ENTITY_PATH)) unlinkSync(RENAMED_ENTITY_PATH);
    writeFileSync(SCHEMA_PATH, ORIGINAL_SCHEMA, 'utf-8');

    await startBackend();

    // Deploy the test entity against the running backend.
    writeFileSync(RENAMED_ENTITY_PATH, RENAMED_ENTITY_CONTENT, 'utf-8');
    writeFileSync(SCHEMA_PATH, SCHEMA_WITH_RENAMED, 'utf-8');

    // NODE_OPTIONS is stripped so the CLI doesn't inherit VS Code debugger flags.
    const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
    execSync('rayfin dev db apply', {
      cwd: TODO_APP_DIR,
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...cleanEnv, CI: 'true' },
    });

    client = createTestClient();
    const user = generateUniqueUser();
    await client.auth.signUp({ email: user.email, password: user.password });
    await client.auth.signIn({ email: user.email, password: user.password });

    const session = client.auth.getSession();
    if (!session.user) throw new Error('Failed to authenticate test user');
    userId = session.user.id;
    accessToken = (client.auth as unknown as { accessToken: string })
      .accessToken;
  }, 240_000);

  afterAll(async () => {
    // Drop the test rows first so the entity can be safely removed from schema.
    for (const id of createdIds) {
      try {
        await executeGraphQL(
          `mutation { deleteColumnMapped(id: "${id}") { id } }`,
          accessToken
        );
      } catch {
        // Best-effort cleanup; ignore so the schema restore still runs.
      }
    }

    writeFileSync(SCHEMA_PATH, ORIGINAL_SCHEMA, 'utf-8');
    if (existsSync(RENAMED_ENTITY_PATH)) unlinkSync(RENAMED_ENTITY_PATH);

    // Re-apply the restored schema against the running backend so the
    // temporary `ColumnMapped` entity is removed from the live DAB config.
    // `stopBackend()` is a no-op when reusing an externally-started backend
    // (e.g. CI or E2E_KEEP_BACKEND_RUNNING=true), so without this any later
    // spec would still see `ColumnMapped` registered.
    try {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      execSync('rayfin dev db apply --force', {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      });
    } catch (err) {
      console.warn(
        `⚠️  Failed to re-apply original schema during cleanup: ${(err as Error).message}`
      );
    }

    await stopBackend();
  });

  it('exposes the TS property name and hides the SQL column name', async () => {
    expect(await probeEntityExists('ColumnMapped', accessToken)).toBe(true);

    const probe = await probeFields(
      'ColumnMapped',
      ['id', 'foo', 'user_id'],
      accessToken
    );
    expect(probe.success).toBe(true);

    // The SQL column name 'Foo' must NOT leak into the GraphQL schema — only
    // the TypeScript property name 'foo' is a valid field.
    expect(await isFieldAbsent('ColumnMapped', 'Foo', accessToken)).toBe(true);
  });

  it('persists writes through the property-name field and reads them back', async () => {
    const value = `value-${Date.now()}`;
    const createResult = await executeGraphQL(
      `mutation {
        createColumnMapped(item: {
          foo: "${value}",
          user_id: "${userId}"
        }) {
          id
          foo
        }
      }`,
      accessToken
    );

    expect(
      createResult.errors,
      JSON.stringify(createResult.errors)
    ).toBeUndefined();
    const created = createResult.data?.createColumnMapped as
      | { id: string; foo: string }
      | undefined;
    expect(created).toBeDefined();
    expect(created!.foo).toBe(value);

    createdIds.push(created!.id);

    const readResult = await executeGraphQL(
      `{
        columnMappeds(filter: { id: { eq: "${created!.id}" } }) {
          items { id foo }
        }
      }`,
      accessToken
    );

    expect(
      readResult.errors,
      JSON.stringify(readResult.errors)
    ).toBeUndefined();
    const items = (
      readResult.data?.columnMappeds as
        | { items: Array<{ id: string; foo: string }> }
        | undefined
    )?.items;
    expect(items).toHaveLength(1);
    expect(items![0].foo).toBe(value);
  });

  it('rejects GraphQL queries that reference the underlying SQL column name', async () => {
    // The SQL column is 'Foo', but neither 'Foo' should be a valid GraphQL
    // field — only the TS property name 'foo' is. This guards against the
    // WebService accidentally leaking the column name into the public schema.
    expect(await isFieldAbsent('ColumnMapped', 'Foo', accessToken)).toBe(true);
  });
});
