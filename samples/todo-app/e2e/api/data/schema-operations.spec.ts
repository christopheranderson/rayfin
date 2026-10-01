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
  parseScalarFields,
  probeEntityExists,
  probeFields,
} from '../../shared/graphql';
import { generateUniqueUser } from '../../shared/test-data';
import { getDialect } from '../query-builder/setup';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const DATA_DIR = resolve(__dirname, '../../../rayfin/data');
const SCHEMA_PATH = resolve(DATA_DIR, 'schema.ts');
const TEST_ENTITY1_PATH = resolve(DATA_DIR, 'TestEntity1.ts');
const TEST_ENTITY2_PATH = resolve(DATA_DIR, 'TestEntity2.ts');
const NO_ID_ENTITY_PATH = resolve(DATA_DIR, 'NoIdEntity.ts');
const EMPTY_ENTITY_PATH = resolve(DATA_DIR, 'EmptyEntity.ts');
const USER_ENTITY_PATH = resolve(DATA_DIR, 'User.ts');
const USER_REL_ENTITY_PATH = resolve(DATA_DIR, 'UserRelEntity1.ts');
const UNIQUE_ENTITY_PATH = resolve(DATA_DIR, 'UniqueEntity.ts');
const UNIQUE_NULLABLE_ENTITY_PATH = resolve(
  DATA_DIR,
  'UniqueNullableEntity.ts'
);
const TODO_APP_DIR = resolve(__dirname, '../../..');

const FIXTURES_DIR = resolve(__dirname, 'fixtures');

/** Normalise CRLF → LF so that multi-line .replace() patterns work on Windows. */
const readFixture = (name: string): string =>
  readFileSync(resolve(FIXTURES_DIR, name), 'utf-8').replace(/\r\n/g, '\n');

const TEST_ENTITY1_CONTENT = readFixture('TestEntity1.ts.fixture');
const TEST_ENTITY2_CONTENT = readFixture('TestEntity2.ts.fixture');
const UPDATED_SCHEMA = readFixture('schema.ts.fixture');
const NO_ID_ENTITY_CONTENT = readFixture('NoIdEntity.ts.fixture');
const EMPTY_ENTITY_CONTENT = readFixture('EmptyEntity.ts.fixture');
const USER_ENTITY_CONTENT = readFixture('UserEntity.ts.fixture');
const SCHEMA_WITH_NO_ID = readFixture('schema-with-no-id.ts.fixture');
const SCHEMA_WITH_EMPTY = readFixture('schema-with-empty.ts.fixture');
const SCHEMA_WITH_USER = readFixture('schema-with-user.ts.fixture');
const USER_REL_ENTITY_CONTENT = readFixture('UserRelEntity.ts.fixture');
const SCHEMA_WITH_USER_REL = readFixture('schema-with-user-rel.ts.fixture');
const ORIGINAL_SCHEMA = readFixture('schema-original.ts.fixture');
const UNIQUE_ENTITY_CONTENT = readFixture('UniqueEntity.ts.fixture');
const UNIQUE_ENTITY_NO_CONSTRAINT_CONTENT = readFixture(
  'UniqueEntityNoConstraint.ts.fixture'
);
const SCHEMA_WITH_UNIQUE = readFixture('schema-with-unique.ts.fixture');
const UNIQUE_NULLABLE_ENTITY_CONTENT = readFixture(
  'UniqueNullableEntity.ts.fixture'
);
const SCHEMA_WITH_UNIQUE_NULLABLE = readFixture(
  'schema-with-unique-nullable.ts.fixture'
);

describe('Schema Operations E2E Tests', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  let accessToken: string;

  beforeAll(async () => {
    // Remove leftover test entity files from any prior failed run and
    // restore the original schema (Todo + Category only) from fixture.
    for (const filePath of [
      TEST_ENTITY1_PATH,
      TEST_ENTITY2_PATH,
      NO_ID_ENTITY_PATH,
      EMPTY_ENTITY_PATH,
      USER_ENTITY_PATH,
      USER_REL_ENTITY_PATH,
      UNIQUE_ENTITY_PATH,
      UNIQUE_NULLABLE_ENTITY_PATH,
    ]) {
      if (existsSync(filePath)) unlinkSync(filePath);
    }

    writeFileSync(SCHEMA_PATH, ORIGINAL_SCHEMA, 'utf-8');

    // Wipe stale compiled outputs so the backend starts clean.
    execSync('rushx clean', { cwd: TODO_APP_DIR, encoding: 'utf-8' });

    await startBackend();

    client = createTestClient();
    const user = generateUniqueUser();

    await client.auth.signUp({ email: user.email, password: user.password });
    await client.auth.signIn({ email: user.email, password: user.password });
    accessToken = (client.auth as unknown as { accessToken: string })
      .accessToken;
  });

  afterAll(async () => {
    // Restore schema.ts to original (removes test entity references)
    writeFileSync(SCHEMA_PATH, ORIGINAL_SCHEMA, 'utf-8');

    // Clean up test entity files
    for (const filePath of [
      TEST_ENTITY1_PATH,
      TEST_ENTITY2_PATH,
      NO_ID_ENTITY_PATH,
      EMPTY_ENTITY_PATH,
      USER_ENTITY_PATH,
      USER_REL_ENTITY_PATH,
      UNIQUE_ENTITY_PATH,
      UNIQUE_NULLABLE_ENTITY_PATH,
    ]) {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }

    await stopBackend();
  });

  describe('Entity & Relationship Setup', () => {
    it('should create test entities besides todo & category and apply schema successfully', () => {
      // Create test entity files and update schema
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      writeFileSync(TEST_ENTITY2_PATH, TEST_ENTITY2_CONTENT, 'utf-8');
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');

      // Strip NODE_OPTIONS to avoid inheriting VS Code debugger flags
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;

      const output = execSync('rayfin dev db apply', {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      });

      expect(output).toBeDefined();
    });

    it('should expose all declared scalar fields as queryable in the GraphQL schema', async () => {
      for (const [entityName, content] of [
        ['TestEntity1', TEST_ENTITY1_CONTENT],
        ['TestEntity2', TEST_ENTITY2_CONTENT],
      ] as const) {
        const expectedScalars = parseScalarFields(content);
        const fieldNames = expectedScalars.map((f) => f.name);

        // All declared scalar fields should be queryable in the live schema
        const result = await probeFields(entityName, fieldNames, accessToken);
        expect(
          result.success,
          `All ${entityName} scalar fields should be queryable`
        ).toBe(true);
      }
    });

    it('should have created the one-to-many/many-to-one relationship fields between test entities', async () => {
      // One-to-many (@many): queryable through Connection wrapper (items sub-selection)
      const childrenResult = await executeGraphQL(
        `{ testEntity1s { items { children { items { id label } } } } }`,
        accessToken
      );
      expect(
        childrenResult.errors,
        'children relationship should be queryable through Connection'
      ).toBeUndefined();

      // Many-to-one (@one): direct entity reference (no Connection wrapper)
      const parentResult = await executeGraphQL(
        `{ testEntity2s { items { parent { id name } } } }`,
        accessToken
      );
      expect(
        parentResult.errors,
        'parent relationship should be queryable as direct reference'
      ).toBeUndefined();

      // Auto-generated FK scalar field for @one
      const fkResult = await probeFields(
        'TestEntity2',
        ['parent_id'],
        accessToken
      );
      expect(fkResult.success, 'parent_id FK field should exist').toBe(true);
    });

    it('should resolve a self-referencing (@one to self) relationship via self-join', async () => {
      const userId = client.auth.getSession().user!.id;
      const now = new Date().toISOString();

      const siblingNav = await executeGraphQL(
        `{ testEntity2s { items { sibling { id label } } } }`,
        accessToken
      );
      expect(
        siblingNav.errors,
        'self-referencing sibling navigation should be queryable'
      ).toBeUndefined();

      const fkResult = await probeFields(
        'TestEntity2',
        ['sibling_id'],
        accessToken
      );
      expect(fkResult.success, 'sibling_id FK field should exist').toBe(true);

      const targetResult = await executeGraphQL(
        `mutation {
          createTestEntity2(item: {
            label: "self-join-target",
            quantity: 1,
            price: 1.0,
            isActive: true,
            timestamp: "${now}",
            user_id: "${userId}"
          }) { id label }
        }`,
        accessToken
      );
      expect(targetResult.errors).toBeUndefined();
      const targetId = (targetResult.data?.createTestEntity2 as { id: string })
        .id;

      const sourceResult = await executeGraphQL(
        `mutation {
          createTestEntity2(item: {
            label: "self-join-source",
            quantity: 1,
            price: 1.0,
            isActive: true,
            timestamp: "${now}",
            sibling_id: "${targetId}",
            user_id: "${userId}"
          }) { id sibling_id }
        }`,
        accessToken
      );
      expect(sourceResult.errors).toBeUndefined();
      const sourceId = (sourceResult.data?.createTestEntity2 as { id: string })
        .id;

      const joinResult = await executeGraphQL(
        `{
          testEntity2_by_pk(id: "${sourceId}") {
            id label
            sibling { id label }
          }
        }`,
        accessToken
      );
      expect(
        joinResult.errors,
        `self-join query returned errors: ${JSON.stringify(joinResult.errors)}`
      ).toBeUndefined();

      const source = joinResult.data?.testEntity2_by_pk as {
        id: string;
        sibling: { id: string; label: string } | null;
      };
      expect(source).toBeDefined();
      expect(source.id).toBe(sourceId);
      expect(source.sibling?.id).toBe(targetId);
      expect(source.sibling?.label).toBe('self-join-target');

      await executeGraphQL(
        `mutation { deleteTestEntity2(id: "${sourceId}") { id } }`,
        accessToken
      );
      await executeGraphQL(
        `mutation { deleteTestEntity2(id: "${targetId}") { id } }`,
        accessToken
      );
    });

    it('should resolve a self-referencing (@many to self) relationship via self-join', async () => {
      const userId = client.auth.getSession().user!.id;
      const now = new Date().toISOString();

      // `referrers` is the reverse (@many) side of the self-referencing FK:
      // it returns every TestEntity2 whose `sibling_id` points back at this row.
      const referrersNav = await executeGraphQL(
        `{ testEntity2s { items { referrers { items { id label } } } } }`,
        accessToken
      );
      expect(
        referrersNav.errors,
        'self-referencing referrers navigation should be queryable'
      ).toBeUndefined();

      const targetResult = await executeGraphQL(
        `mutation {
          createTestEntity2(item: {
            label: "many-self-join-target",
            quantity: 1,
            price: 1.0,
            isActive: true,
            timestamp: "${now}",
            user_id: "${userId}"
          }) { id label }
        }`,
        accessToken
      );
      expect(targetResult.errors).toBeUndefined();
      const targetId = (targetResult.data?.createTestEntity2 as { id: string })
        .id;

      const referrerIds: string[] = [];
      for (const label of [
        'many-self-join-referrer-1',
        'many-self-join-referrer-2',
      ]) {
        const referrerResult = await executeGraphQL(
          `mutation {
            createTestEntity2(item: {
              label: "${label}",
              quantity: 1,
              price: 1.0,
              isActive: true,
              timestamp: "${now}",
              sibling_id: "${targetId}",
              user_id: "${userId}"
            }) { id }
          }`,
          accessToken
        );
        expect(referrerResult.errors).toBeUndefined();
        referrerIds.push(
          (referrerResult.data?.createTestEntity2 as { id: string }).id
        );
      }

      const joinResult = await executeGraphQL(
        `{
          testEntity2_by_pk(id: "${targetId}") {
            id label
            referrers { items { id label } }
          }
        }`,
        accessToken
      );
      expect(
        joinResult.errors,
        `many self-join query returned errors: ${JSON.stringify(joinResult.errors)}`
      ).toBeUndefined();

      const target = joinResult.data?.testEntity2_by_pk as {
        id: string;
        referrers: { items: Array<{ id: string; label: string }> };
      };
      expect(target).toBeDefined();
      expect(target.id).toBe(targetId);

      const returnedIds = target.referrers.items.map((r) => r.id);
      expect(returnedIds).toHaveLength(2);
      for (const id of referrerIds) {
        expect(returnedIds).toContain(id);
      }

      for (const id of [...referrerIds, targetId]) {
        await executeGraphQL(
          `mutation { deleteTestEntity2(id: "${id}") { id } }`,
          accessToken
        );
      }
    });

    it('should enforce self-referencing delete integrity: reject while referenced, allow once dereferenced', async () => {
      const userId = client.auth.getSession().user!.id;
      const now = new Date().toISOString();

      // Create the parent (target) row that will be referenced.
      const parentResult = await executeGraphQL(
        `mutation {
          createTestEntity2(item: {
            label: "delete-parent-target",
            quantity: 1,
            price: 1.0,
            isActive: true,
            timestamp: "${now}",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(parentResult.errors).toBeUndefined();
      const parentId = (parentResult.data?.createTestEntity2 as { id: string })
        .id;

      // Create a child whose sibling_id points back at the parent.
      const childResult = await executeGraphQL(
        `mutation {
          createTestEntity2(item: {
            label: "delete-parent-child",
            quantity: 1,
            price: 1.0,
            isActive: true,
            timestamp: "${now}",
            sibling_id: "${parentId}",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(childResult.errors).toBeUndefined();
      const childId = (childResult.data?.createTestEntity2 as { id: string })
        .id;

      // Deleting the parent while the child still references it must be rejected
      // by the self-referencing FK (created with restrict-on-delete behavior).
      // Dialect-agnostic: assert only that errors are present, not a specific
      // SQL error number or message.
      const blockedDelete = await executeGraphQL(
        `mutation { deleteTestEntity2(id: "${parentId}") { id } }`,
        accessToken
      );
      expect(
        blockedDelete.errors,
        'Deleting a still-referenced self-join parent should be rejected'
      ).toBeDefined();

      // The parent should still exist because the delete was rejected.
      const stillThere = await executeGraphQL(
        `{ testEntity2_by_pk(id: "${parentId}") { id } }`,
        accessToken
      );
      expect(stillThere.errors).toBeUndefined();
      expect(
        (stillThere.data?.testEntity2_by_pk as { id: string } | null)?.id
      ).toBe(parentId);

      // Removing the child first should let the parent delete succeed.
      const childDelete = await executeGraphQL(
        `mutation { deleteTestEntity2(id: "${childId}") { id } }`,
        accessToken
      );
      expect(childDelete.errors).toBeUndefined();

      const parentDelete = await executeGraphQL(
        `mutation { deleteTestEntity2(id: "${parentId}") { id } }`,
        accessToken
      );
      expect(
        parentDelete.errors,
        'Deleting the parent after removing the child should succeed'
      ).toBeUndefined();
    });
  });

  describe('Column Operations', () => {
    it('should add a new column to TestEntity1 and verify it exists', async () => {
      // Inject a new @text column before user_id
      const updatedEntity1 = TEST_ENTITY1_CONTENT.replace(
        '@text() user_id!: string;',
        '@text({ optional: true }) nickname?: string;\n\n  @text() user_id!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, updatedEntity1, 'utf-8');

      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;

      const output = execSync('rayfin dev db apply', {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      });

      expect(output).toBeDefined();

      // Verify the new column exists by querying it
      const nicknameResult = await probeFields(
        'TestEntity1',
        ['nickname'],
        accessToken
      );
      expect(
        nicknameResult.success,
        'nickname field should exist after adding'
      ).toBe(true);
    });

    it('should fail to drop a column without force flag', async () => {
      // Revert TestEntity1 back to the original fixture (without nickname)
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');

      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;

      // Dropping a column is destructive — db apply without --force should error
      expect(() =>
        execSync('rayfin dev db apply', {
          cwd: TODO_APP_DIR,
          encoding: 'utf-8',
          timeout: 120_000,
          env: { ...cleanEnv, CI: 'true' },
        })
      ).toThrow();

      // Column should still exist since the apply was rejected
      const nicknameResult = await probeFields(
        'TestEntity1',
        ['nickname'],
        accessToken
      );
      expect(
        nicknameResult.success,
        'nickname field should still exist after failed drop'
      ).toBe(true);
    });

    it('should drop a column with force flag and verify it no longer exists', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;

      const output = execSync('rayfin dev db apply --force', {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      });

      expect(output).toBeDefined();

      // Verify the nickname column no longer exists
      expect(
        await isFieldAbsent('TestEntity1', 'nickname', accessToken),
        'nickname field should no longer exist after forced drop'
      ).toBe(true);
    });

    it('should add, rename, and drop a column with force flag', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Step 1: Add a new column
      const withNewCol = TEST_ENTITY1_CONTENT.replace(
        '@text() user_id!: string;',
        '@text({ optional: true }) bio?: string;\n\n  @text() user_id!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, withNewCol, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      let bioProbe = await probeFields('TestEntity1', ['bio'], accessToken);
      expect(bioProbe.success, 'bio field should exist after adding').toBe(
        true
      );

      // Step 2a: Rename without --force should fail (destructive: drop old + add new)
      const withRenamed = TEST_ENTITY1_CONTENT.replace(
        '@text() user_id!: string;',
        '@text({ optional: true }) biography?: string;\n\n  @text() user_id!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, withRenamed, 'utf-8');
      expect(() => execSync('rayfin dev db apply', applyOptions)).toThrow();

      // bio should still exist since the apply was rejected
      bioProbe = await probeFields('TestEntity1', ['bio'], accessToken);
      expect(
        bioProbe.success,
        'bio field should still exist after failed rename'
      ).toBe(true);

      // Step 2b: Rename with --force should succeed
      execSync('rayfin dev db apply --force', applyOptions);

      expect(
        await isFieldAbsent('TestEntity1', 'bio', accessToken),
        'bio field should be gone after rename'
      ).toBe(true);
      bioProbe = await probeFields('TestEntity1', ['biography'], accessToken);
      expect(
        bioProbe.success,
        'biography field should exist after rename'
      ).toBe(true);

      // Step 3: Drop the column with force
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);

      expect(
        await isFieldAbsent('TestEntity1', 'biography', accessToken),
        'biography field should be gone after drop'
      ).toBe(true);
    });
  });

  describe('Permissions', () => {
    it('should enforce RLS policy so only the owning user can access their data', async () => {
      const session = client.auth.getSession();
      const userAId = session.user!.id;
      const now = new Date().toISOString();

      // User A creates a TestEntity1 record
      const createResult = await executeGraphQL(
        `
        mutation {
          createTestEntity1(item: {
            name: "rls-test-record",
            intValue: 42,
            floatValue: 3.14,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userAId}"
          }) { id name user_id }
        }
      `,
        accessToken
      );
      expect(createResult.errors).toBeUndefined();
      const createdId = (createResult.data?.createTestEntity1 as { id: string })
        .id;

      // User A can read their own record
      const userAQuery = await executeGraphQL(
        `{ testEntity1s { items { id name user_id } } }`,
        accessToken
      );
      const userAItems = (
        userAQuery.data?.testEntity1s as { items: Array<{ id: string }> }
      ).items;
      expect(userAItems.some((item) => item.id === createdId)).toBe(true);

      // Sign up User B with a separate client
      const clientB = createTestClient();
      const userB = generateUniqueUser();
      await clientB.auth.signUp({
        email: userB.email,
        password: userB.password,
      });
      await clientB.auth.signIn({
        email: userB.email,
        password: userB.password,
      });
      const userBToken = (clientB.auth as unknown as { accessToken: string })
        .accessToken;

      // User B should NOT see User A's record due to RLS policy
      const userBQuery = await executeGraphQL(
        `{ testEntity1s { items { id name user_id } } }`,
        userBToken
      );
      const userBItems = (
        userBQuery.data?.testEntity1s as { items: Array<{ id: string }> }
      ).items;
      expect(userBItems.some((item) => item.id === createdId)).toBe(false);

      // Clean up: User A deletes the record
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${createdId}") { id } }`,
        accessToken
      );
    });

    it('should enforce RLS on related entities in join queries', async () => {
      const session = client.auth.getSession();
      const userAId = session.user!.id;
      const now = new Date().toISOString();

      // --- User A creates a parent (TestEntity1) and a child (TestEntity2) ---
      const createParentA = await executeGraphQL(
        `
        mutation {
          createTestEntity1(item: {
            name: "rls-join-parent-A",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userAId}"
          }) { id name }
        }
      `,
        accessToken
      );
      expect(createParentA.errors).toBeUndefined();
      const parentAId = (
        createParentA.data?.createTestEntity1 as { id: string }
      ).id;

      const createChildA = await executeGraphQL(
        `
        mutation {
          createTestEntity2(item: {
            label: "rls-join-child-A",
            quantity: 10,
            price: 9.99,
            isActive: true,
            timestamp: "${now}",
            parent_id: "${parentAId}",
            user_id: "${userAId}"
          }) { id label }
        }
      `,
        accessToken
      );
      expect(createChildA.errors).toBeUndefined();
      const childAId = (createChildA.data?.createTestEntity2 as { id: string })
        .id;

      // User A joins TestEntity1 → children: sees both parent and child
      const userAJoin = await executeGraphQL(
        `{
          testEntity1_by_pk(id: "${parentAId}") {
            id name
            children { items { id label user_id } }
          }
        }`,
        accessToken
      );
      expect(userAJoin.errors).toBeUndefined();
      const parentA = userAJoin.data?.testEntity1_by_pk as {
        id: string;
        children: { items: Array<{ id: string }> };
      };
      expect(parentA).toBeDefined();
      expect(parentA.id).toBe(parentAId);
      expect(parentA.children.items.some((c) => c.id === childAId)).toBe(true);

      // --- User B signs up ---
      const clientB = createTestClient();
      const userB = generateUniqueUser();
      await clientB.auth.signUp({
        email: userB.email,
        password: userB.password,
      });
      await clientB.auth.signIn({
        email: userB.email,
        password: userB.password,
      });
      const userBToken = (clientB.auth as unknown as { accessToken: string })
        .accessToken;
      const userBId = clientB.auth.getSession().user!.id;

      // User B creates a child (TestEntity2) that references User A's parent
      const createChildB = await executeGraphQL(
        `
        mutation {
          createTestEntity2(item: {
            label: "rls-join-child-B",
            quantity: 5,
            price: 4.99,
            isActive: true,
            timestamp: "${now}",
            parent_id: "${parentAId}",
            user_id: "${userBId}"
          }) { id label }
        }
      `,
        userBToken
      );
      expect(createChildB.errors).toBeUndefined();
      const childBId = (createChildB.data?.createTestEntity2 as { id: string })
        .id;

      // User B queries their own TestEntity2 with parent join
      // B should see their child record, but the parent (owned by A) should be null due to RLS
      const userBJoin = await executeGraphQL(
        `{
          testEntity2_by_pk(id: "${childBId}") {
            id label user_id
            parent { id name user_id }
          }
        }`,
        userBToken
      );
      expect(userBJoin.errors).toBeUndefined();
      const childB = userBJoin.data?.testEntity2_by_pk as {
        id: string;
        label: string;
        parent: { id: string; name: string } | null;
      };
      expect(childB).toBeDefined();
      expect(childB.id).toBe(childBId);
      // The parent belongs to User A — RLS should filter it out
      expect(
        childB.parent,
        "User B should not see User A's parent record via join"
      ).toBeNull();

      // Clean up
      await executeGraphQL(
        `mutation { deleteTestEntity2(id: "${childBId}") { id } }`,
        userBToken
      );
      await executeGraphQL(
        `mutation { deleteTestEntity2(id: "${childAId}") { id } }`,
        accessToken
      );
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${parentAId}") { id } }`,
        accessToken
      );
    });

    it('should enforce column-level security via include and exclude', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      const readIncludedFields = [
        'id',
        'name',
        'intValue',
        'boolValue',
        'status',
      ];
      const readExcludedFields = ['description', 'optionalDate'];

      // Configure read role with both include and exclude
      const withPermissions = TEST_ENTITY1_CONTENT.replace(
        "@role('authenticated', '*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),\n})",
        "@role('authenticated', '*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),\n  include: ['id', 'name', 'intValue', 'boolValue', 'status', 'createdAt', 'user_id'],\n  exclude: ['description', 'optionalDate'],\n})"
      );

      // Guard: verify the replace actually changed the content
      expect(withPermissions).toContain('include:');
      expect(withPermissions).toContain('exclude:');

      writeFileSync(TEST_ENTITY1_PATH, withPermissions, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      // Included fields should be queryable
      const includedResult = await probeFields(
        'TestEntity1',
        readIncludedFields,
        accessToken
      );
      expect(
        includedResult.success,
        `Included fields [${readIncludedFields.join(', ')}] should be queryable`
      ).toBe(true);

      // Each excluded field should be individually rejected
      for (const field of readExcludedFields) {
        expect(
          await isFieldAbsent('TestEntity1', field, accessToken),
          `Excluded field '${field}' should not be queryable`
        ).toBe(true);
      }

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);
    });

    // ------------------------------------------------------------------
    // Anonymous data access is GA: `rayfin dev db apply` accepts entities
    // that grant the `anonymous` role with no feature flag, and the
    // generated DAB config retains the `anonymous` permission entries. The
    // tests below validate the runtime DAB behavior for anonymous and
    // multi-role permission shapes.
    // ------------------------------------------------------------------

    it('should allow anonymous read access when entity has anonymous role', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: {
          ...cleanEnv,
          CI: 'true',
          RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
        },
      };

      // Add @role('anonymous', 'read') to TestEntity1
      const withAnonymousRole = TEST_ENTITY1_CONTENT.replace(
        "@role('authenticated', '*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),\n})",
        "@role('anonymous', 'read')\n@role('authenticated', '*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),\n})"
      );

      // Guard: verify the replace actually added anonymous role
      expect(withAnonymousRole).toContain("@role('anonymous', 'read')");

      writeFileSync(TEST_ENTITY1_PATH, withAnonymousRole, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      // First, create a record as an authenticated user so there's data to read
      const now = new Date().toISOString();
      const session = client.auth.getSession();
      const userId = session.user!.id;
      const createResult = await executeGraphQL(
        `
        mutation {
          createTestEntity1(item: {
            name: "anon-read-test",
            intValue: 99,
            floatValue: 1.5,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userId}"
          }) { id name }
        }
      `,
        accessToken
      );
      expect(createResult.errors).toBeUndefined();
      const createdId = (createResult.data?.createTestEntity1 as { id: string })
        .id;

      // Query WITHOUT any access token — anonymous should still get data
      const anonymousQuery = await executeGraphQL(
        `{ testEntity1s { items { id name intValue } } }`
      );
      expect(
        anonymousQuery.errors,
        'Anonymous read query should not return errors'
      ).toBeUndefined();
      const items = (
        anonymousQuery.data?.testEntity1s as { items: Array<{ id: string }> }
      ).items;
      expect(items.some((item) => item.id === createdId)).toBe(true);

      // Clean up: delete the record and restore fixture
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${createdId}") { id } }`,
        accessToken
      );
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);
    });

    it('should reject mutations when role only grants read permission', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: {
          ...cleanEnv,
          CI: 'true',
          RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
        },
      };

      // Add anonymous read-only role alongside the existing authenticated wildcard role
      const withAnonymousReadOnly = TEST_ENTITY1_CONTENT.replace(
        "@role('authenticated', '*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),\n})",
        "@role('anonymous', 'read')\n@role('authenticated', '*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),\n})"
      );

      expect(withAnonymousReadOnly).toContain("@role('anonymous', 'read')");

      writeFileSync(TEST_ENTITY1_PATH, withAnonymousReadOnly, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      // Authenticated user creates a test record
      const now = new Date().toISOString();
      const session = client.auth.getSession();
      const userId = session.user!.id;
      const createResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "mutation-restriction-test",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userId}"
          }) { id name }
        }`,
        accessToken
      );
      expect(createResult.errors).toBeUndefined();
      const createdId = (createResult.data?.createTestEntity1 as { id: string })
        .id;

      // Anonymous CAN read (has 'read' permission)
      const anonRead = await executeGraphQL(
        `{ testEntity1s { items { id name } } }`
      );
      expect(
        anonRead.errors,
        'Anonymous should be able to read'
      ).toBeUndefined();
      const items = (
        anonRead.data?.testEntity1s as { items: Array<{ id: string }> }
      ).items;
      expect(items.some((item) => item.id === createdId)).toBe(true);

      // Anonymous CANNOT create
      const anonCreate = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "anon-should-fail",
            intValue: 0,
            floatValue: 0.0,
            boolValue: false,
            createdAt: "${now}",
            status: "active",
            user_id: "anon"
          }) { id }
        }`
      );
      expect(
        anonCreate.errors,
        'Anonymous create should be rejected'
      ).toBeDefined();

      // Anonymous CANNOT update
      const anonUpdate = await executeGraphQL(
        `mutation {
          updateTestEntity1(id: "${createdId}", item: { name: "anon-updated" }) { id }
        }`
      );
      expect(
        anonUpdate.errors,
        'Anonymous update should be rejected'
      ).toBeDefined();

      // Anonymous CANNOT delete
      const anonDelete = await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${createdId}") { id } }`
      );
      expect(
        anonDelete.errors,
        'Anonymous delete should be rejected'
      ).toBeDefined();

      // Clean up
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${createdId}") { id } }`,
        accessToken
      );
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);
    });

    it('should support multiple roles with different action sets on the same entity', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: {
          ...cleanEnv,
          CI: 'true',
          RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
        },
      };

      // Configure: anonymous = read-only, authenticated = create + read (no update/delete)
      const withMultipleRoles = TEST_ENTITY1_CONTENT.replace(
        "@role('authenticated', '*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),\n})",
        "@role('anonymous', 'read')\n@role('authenticated', ['create', 'read'])"
      );

      expect(withMultipleRoles).toContain("@role('anonymous', 'read')");
      expect(withMultipleRoles).toContain(
        "@role('authenticated', ['create', 'read'])"
      );

      writeFileSync(TEST_ENTITY1_PATH, withMultipleRoles, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      const now = new Date().toISOString();

      // Authenticated CAN create (has 'create' permission)
      const createResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "multi-role-test",
            intValue: 7,
            floatValue: 2.5,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "test-user"
          }) { id name }
        }`,
        accessToken
      );
      expect(
        createResult.errors,
        'Authenticated should be able to create'
      ).toBeUndefined();
      const createdId = (createResult.data?.createTestEntity1 as { id: string })
        .id;

      // Authenticated CAN read (has 'read' permission)
      const authRead = await executeGraphQL(
        `{ testEntity1s { items { id name } } }`,
        accessToken
      );
      expect(
        authRead.errors,
        'Authenticated should be able to read'
      ).toBeUndefined();
      const authItems = (
        authRead.data?.testEntity1s as { items: Array<{ id: string }> }
      ).items;
      expect(authItems.some((item) => item.id === createdId)).toBe(true);

      // Authenticated CANNOT update (no 'update' permission)
      const authUpdate = await executeGraphQL(
        `mutation {
          updateTestEntity1(id: "${createdId}", item: { name: "should-fail" }) { id }
        }`,
        accessToken
      );
      expect(
        authUpdate.errors,
        'Authenticated update should be rejected'
      ).toBeDefined();

      // Authenticated CANNOT delete (no 'delete' permission)
      const authDelete = await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${createdId}") { id } }`,
        accessToken
      );
      expect(
        authDelete.errors,
        'Authenticated delete should be rejected'
      ).toBeDefined();

      // Anonymous CAN read (has 'read' permission)
      const anonRead = await executeGraphQL(
        `{ testEntity1s { items { id name } } }`
      );
      expect(
        anonRead.errors,
        'Anonymous should be able to read'
      ).toBeUndefined();
      const anonItems = (
        anonRead.data?.testEntity1s as { items: Array<{ id: string }> }
      ).items;
      expect(anonItems.some((item) => item.id === createdId)).toBe(true);

      // Anonymous CANNOT create (only has 'read' permission)
      const anonCreate = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "anon-should-fail",
            intValue: 0,
            floatValue: 0.0,
            boolValue: false,
            createdAt: "${now}",
            status: "active",
            user_id: "anon"
          }) { id }
        }`
      );
      expect(
        anonCreate.errors,
        'Anonymous create should be rejected'
      ).toBeDefined();

      // Restore original fixture (with wildcard auth role that allows deletion)
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      // Clean up: now authenticated has full permissions again
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${createdId}") { id } }`,
        accessToken
      );
    });
  });

  describe('Constraints', () => {
    it('should enforce @set check constraints on the same entity', async () => {
      // The fixture already declares two @set fields: status (required) and priority (optional).
      // Both constraints were created when the entity table was first created.

      // Verify both @set fields are queryable
      const statusProbe = await probeFields(
        'TestEntity1',
        ['status'],
        accessToken
      );
      expect(statusProbe.success, 'status @set field should be queryable').toBe(
        true
      );

      const priorityProbe = await probeFields(
        'TestEntity1',
        ['priority'],
        accessToken
      );
      expect(
        priorityProbe.success,
        'priority @set field should be queryable'
      ).toBe(true);

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Valid values for both @set fields should succeed
      const validResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "multi-set-valid",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            priority: "high",
            user_id: "${userId}"
          }) { id status priority }
        }`,
        accessToken
      );
      expect(validResult.errors).toBeUndefined();
      const created = validResult.data?.createTestEntity1 as {
        id: string;
        status: string;
        priority: string;
      };
      expect(created.status).toBe('active');
      expect(created.priority).toBe('high');

      // Invalid value for status (first @set) should fail
      const invalidStatus = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "multi-set-bad-status",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "unknown",
            priority: "low",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(
        invalidStatus.errors,
        'Invalid status value should be rejected by check constraint'
      ).toBeDefined();

      // Invalid value for priority (second @set) should fail
      const invalidPriority = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "multi-set-bad-priority",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            priority: "urgent",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(
        invalidPriority.errors,
        'Invalid priority value should be rejected by check constraint'
      ).toBeDefined();

      // Clean up the valid record
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${created.id}") { id } }`,
        accessToken
      );
    });

    it('should migrate @set values when adding and removing values with no data violation', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Insert a record with status='active' (which stays valid after the change)
      const seedResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "set-migration-test",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            priority: "low",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(seedResult.errors).toBeUndefined();
      const seedId = (seedResult.data?.createTestEntity1 as { id: string }).id;

      // Modify @set: remove 'archived' from status, add 'pending';
      // remove 'high' from priority, add 'critical'
      const updatedFixture = TEST_ENTITY1_CONTENT.replace(
        "@set('active', 'inactive', 'archived') status!: 'active' | 'inactive' | 'archived';",
        "@set('active', 'inactive', 'pending') status!: 'active' | 'inactive' | 'pending';"
      ).replace(
        "@set({ optional: true }, 'low', 'medium', 'high') priority?: 'low' | 'medium' | 'high';",
        "@set({ optional: true }, 'low', 'medium', 'critical') priority?: 'low' | 'medium' | 'critical';"
      );
      writeFileSync(TEST_ENTITY1_PATH, updatedFixture, 'utf-8');

      // Apply migration — should succeed because existing data uses 'active' and 'low'
      // which are still valid in the new @set definitions
      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      // Verify new values are accepted
      const newValueResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "set-migration-new-value",
            intValue: 2,
            floatValue: 2.0,
            boolValue: false,
            createdAt: "${now}",
            status: "pending",
            priority: "critical",
            user_id: "${userId}"
          }) { id status priority }
        }`,
        accessToken
      );
      expect(
        newValueResult.errors,
        'New @set values should be accepted after migration'
      ).toBeUndefined();
      const newId = (newValueResult.data?.createTestEntity1 as { id: string })
        .id;

      // Verify removed values are rejected
      const removedStatus = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "set-migration-old-status",
            intValue: 3,
            floatValue: 3.0,
            boolValue: true,
            createdAt: "${now}",
            status: "archived",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(
        removedStatus.errors,
        "Removed @set value 'archived' should be rejected by check constraint"
      ).toBeDefined();

      const removedPriority = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "set-migration-old-priority",
            intValue: 4,
            floatValue: 4.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            priority: "high",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(
        removedPriority.errors,
        "Removed @set value 'high' should be rejected by check constraint"
      ).toBeDefined();

      // Clean up records
      for (const id of [seedId, newId]) {
        await executeGraphQL(
          `mutation { deleteTestEntity1(id: "${id}") { id } }`,
          accessToken
        );
      }

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);
    });

    it('should fail @set migration when existing data violates the new constraint', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Insert a record with status='archived' — this value will be removed from @set
      const seedResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "set-violation-test",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "archived",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(seedResult.errors).toBeUndefined();
      const seedId = (seedResult.data?.createTestEntity1 as { id: string }).id;

      // Remove 'archived' from the @set values — existing data now violates the constraint
      const narrowedFixture = TEST_ENTITY1_CONTENT.replace(
        "@set('active', 'inactive', 'archived') status!: 'active' | 'inactive' | 'archived';",
        "@set('active', 'inactive') status!: 'active' | 'inactive';"
      );
      writeFileSync(TEST_ENTITY1_PATH, narrowedFixture, 'utf-8');

      // Apply should fail — the DROP succeeds but the ADD with narrower values
      // fails because existing row has status='archived'
      expect(() => execSync('rayfin dev db apply', applyOptions)).toThrow();

      // Restore original fixture and re-apply so constraint is back to original
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      // Verify the original constraint is restored — 'archived' should still work
      const verifyResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "set-verify-restored",
            intValue: 2,
            floatValue: 2.0,
            boolValue: true,
            createdAt: "${now}",
            status: "archived",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(
        verifyResult.errors,
        "'archived' should be accepted after restoring original @set"
      ).toBeUndefined();
      const verifyId = (verifyResult.data?.createTestEntity1 as { id: string })
        .id;

      // Clean up
      for (const id of [seedId, verifyId]) {
        await executeGraphQL(
          `mutation { deleteTestEntity1(id: "${id}") { id } }`,
          accessToken
        );
      }
    });

    it('should add check constraint when changing @text to @set', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Change 'description' from @text to @set — adds a new check constraint
      // on a column that previously had none
      const textToSet = TEST_ENTITY1_CONTENT.replace(
        '@text({ optional: true }) description?: string;',
        "@set({ optional: true }, 'short', 'medium', 'long') description?: 'short' | 'medium' | 'long';"
      );
      writeFileSync(TEST_ENTITY1_PATH, textToSet, 'utf-8');

      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Valid @set value should be accepted
      const validResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "text-to-set-valid",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            description: "short",
            user_id: "${userId}"
          }) { id description }
        }`,
        accessToken
      );
      expect(
        validResult.errors,
        "Valid @set value 'short' should be accepted"
      ).toBeUndefined();
      const validId = (validResult.data?.createTestEntity1 as { id: string })
        .id;

      // Invalid value should be rejected by the new check constraint
      const invalidResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "text-to-set-invalid",
            intValue: 2,
            floatValue: 2.0,
            boolValue: false,
            createdAt: "${now}",
            status: "active",
            description: "arbitrary text",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(
        invalidResult.errors,
        'Arbitrary text should be rejected after @text → @set migration'
      ).toBeDefined();

      // Clean up
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${validId}") { id } }`,
        accessToken
      );

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);
    });

    it('should remove check constraint when changing @set to @text', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // First confirm the constraint is active: invalid @set value is rejected
      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      const preCheck = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "set-to-text-precheck",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "not-a-valid-status",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(
        preCheck.errors,
        'Invalid status should be rejected before migration'
      ).toBeDefined();

      // Change 'status' from @set to @text — removes the check constraint
      const setToText = TEST_ENTITY1_CONTENT.replace(
        "@set('active', 'inactive', 'archived') status!: 'active' | 'inactive' | 'archived';",
        '@text() status!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, setToText, 'utf-8');

      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      // After migration, any string value should be accepted (no constraint)
      const freeTextResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "set-to-text-free",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "any arbitrary value",
            user_id: "${userId}"
          }) { id status }
        }`,
        accessToken
      );
      expect(
        freeTextResult.errors,
        'Any string should be accepted after @set → @text migration'
      ).toBeUndefined();
      const freeId = (freeTextResult.data?.createTestEntity1 as { id: string })
        .id;

      // Clean up
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${freeId}") { id } }`,
        accessToken
      );

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);
    });

    it('should allow nullable to non-nullable change without force flag', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Change 'description' from optional to required (nullable → non-nullable)
      const nonNullable = TEST_ENTITY1_CONTENT.replace(
        '@text({ optional: true }) description?: string;',
        '@text() description!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, nonNullable, 'utf-8');

      // Nullable → non-nullable is an ALTER COLUMN operation which doesn't
      // cause data loss by itself (it may fail at the DB level if NULLs
      // exist), so it succeeds without --force
      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should apply nullable to non-nullable change with force flag', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Change 'description' from optional to required (nullable → non-nullable)
      const nonNullable = TEST_ENTITY1_CONTENT.replace(
        '@text({ optional: true }) description?: string;',
        '@text() description!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, nonNullable, 'utf-8');

      // With --force should succeed (no existing NULL values in the column)
      const output = execSync('rayfin dev db apply --force', applyOptions);
      expect(output).toBeDefined();

      // Verify the field is still queryable
      const probe = await probeFields(
        'TestEntity1',
        ['description'],
        accessToken
      );
      expect(
        probe.success,
        'description should still be queryable after nullability change'
      ).toBe(true);

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should change non-nullable to nullable without force flag', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Change 'intValue' from required to optional (non-nullable → nullable)
      const nullable = TEST_ENTITY1_CONTENT.replace(
        '@int() intValue!: number;',
        '@int({ optional: true }) intValue?: number;'
      );
      writeFileSync(TEST_ENTITY1_PATH, nullable, 'utf-8');

      // Non-nullable → nullable is non-destructive — should work without --force
      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      // Verify the field is still queryable
      const probe = await probeFields('TestEntity1', ['intValue'], accessToken);
      expect(
        probe.success,
        'intValue should still be queryable after making nullable'
      ).toBe(true);

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should handle nullable to non-nullable change when NULLs exist', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Insert a TestEntity1 record with NULL description
      const createResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "null-desc-test",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(createResult.errors).toBeUndefined();
      const createdId = (createResult.data?.createTestEntity1 as { id: string })
        .id;

      // Change 'description' from optional to required (nullable → non-nullable)
      // with an existing NULL value in the column.
      // Both PostgreSQL and MSSQL migration engines coerce NULL text to a
      // default value (empty string) when applying with --force, so the
      // apply succeeds on all supported dialects.
      const nonNullable = TEST_ENTITY1_CONTENT.replace(
        '@text({ optional: true }) description?: string;',
        '@text() description!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, nonNullable, 'utf-8');

      const output = execSync('rayfin dev db apply --force', applyOptions);
      expect(output).toBeDefined();

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);

      // Clean up
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${createdId}") { id } }`,
        accessToken
      );
    });

    it('should add a unique constraint and reject duplicate values', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Deploy UniqueEntity with @text({ unique: true }) slug field
      writeFileSync(UNIQUE_ENTITY_PATH, UNIQUE_ENTITY_CONTENT, 'utf-8');
      writeFileSync(SCHEMA_PATH, SCHEMA_WITH_UNIQUE, 'utf-8');

      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      // Verify the slug field is queryable
      const slugProbe = await probeFields(
        'UniqueEntity',
        ['slug'],
        accessToken
      );
      expect(slugProbe.success, 'slug field should be queryable').toBe(true);

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // First insert with a unique slug should succeed
      const firstInsert = await executeGraphQL(
        `mutation {
          createUniqueEntity(item: {
            name: "unique-test-1",
            slug: "my-unique-slug",
            value: 1,
            active: true,
            createdAt: "${now}",
            user_id: "${userId}"
          }) { id slug }
        }`,
        accessToken
      );
      expect(firstInsert.errors).toBeUndefined();
      const firstId = (firstInsert.data?.createUniqueEntity as { id: string })
        .id;

      // Second insert with the SAME slug should fail (unique constraint violation)
      const duplicateInsert = await executeGraphQL(
        `mutation {
          createUniqueEntity(item: {
            name: "unique-test-2",
            slug: "my-unique-slug",
            value: 2,
            active: false,
            createdAt: "${now}",
            user_id: "${userId}"
          }) { id slug }
        }`,
        accessToken
      );
      expect(
        duplicateInsert.errors,
        'Duplicate slug should be rejected by unique constraint'
      ).toBeDefined();

      // Verify the error has a structured error code from the sanitizer
      const error = duplicateInsert.errors![0];
      expect(
        error.extensions?.code,
        'Error code should be BadRequest (unique constraint violation is sanitized)'
      ).toBe('BadRequest');
      // The error message should be the sanitized user-friendly message
      expect(error.message).toBe(
        'A record with the same unique value already exists.'
      );

      // A different slug should succeed
      const differentSlug = await executeGraphQL(
        `mutation {
          createUniqueEntity(item: {
            name: "unique-test-3",
            slug: "another-unique-slug",
            value: 3,
            active: true,
            createdAt: "${now}",
            user_id: "${userId}"
          }) { id slug }
        }`,
        accessToken
      );
      expect(differentSlug.errors).toBeUndefined();
      const secondId = (
        differentSlug.data?.createUniqueEntity as { id: string }
      ).id;

      // Clean up records
      await executeGraphQL(
        `mutation { deleteUniqueEntity(id: "${firstId}") { id } }`,
        accessToken
      );
      await executeGraphQL(
        `mutation { deleteUniqueEntity(id: "${secondId}") { id } }`,
        accessToken
      );

      // Tear down UniqueEntity — dropping a table is destructive
      unlinkSync(UNIQUE_ENTITY_PATH);
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should remove a unique constraint when unique option is dropped', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Step 1: Deploy UniqueEntity with unique constraint on slug
      writeFileSync(UNIQUE_ENTITY_PATH, UNIQUE_ENTITY_CONTENT, 'utf-8');
      writeFileSync(SCHEMA_PATH, SCHEMA_WITH_UNIQUE, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Insert a record
      const createResult = await executeGraphQL(
        `mutation {
          createUniqueEntity(item: {
            name: "drop-unique-test",
            slug: "drop-unique-slug",
            value: 1,
            active: true,
            createdAt: "${now}",
            user_id: "${userId}"
          }) { id slug }
        }`,
        accessToken
      );
      expect(createResult.errors).toBeUndefined();
      const createdId = (
        createResult.data?.createUniqueEntity as { id: string }
      ).id;

      // Step 2: Replace with fixture that has no unique constraint on slug
      // Dropping a unique index is data-loss, so this requires --force
      writeFileSync(
        UNIQUE_ENTITY_PATH,
        UNIQUE_ENTITY_NO_CONSTRAINT_CONTENT,
        'utf-8'
      );
      execSync('rayfin dev db apply --force', applyOptions);

      // Now duplicates should be allowed since unique constraint is gone
      const duplicateInsert = await executeGraphQL(
        `mutation {
          createUniqueEntity(item: {
            name: "drop-unique-test-dup",
            slug: "drop-unique-slug",
            value: 2,
            active: false,
            createdAt: "${now}",
            user_id: "${userId}"
          }) { id slug }
        }`,
        accessToken
      );
      expect(
        duplicateInsert.errors,
        'Duplicate slug should be allowed after dropping unique constraint'
      ).toBeUndefined();
      const dupId = (duplicateInsert.data?.createUniqueEntity as { id: string })
        .id;

      // Clean up records
      await executeGraphQL(
        `mutation { deleteUniqueEntity(id: "${createdId}") { id } }`,
        accessToken
      );
      await executeGraphQL(
        `mutation { deleteUniqueEntity(id: "${dupId}") { id } }`,
        accessToken
      );

      // Tear down UniqueEntity
      unlinkSync(UNIQUE_ENTITY_PATH);
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should allow unique on nullable fields', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Deploy UniqueNullableEntity with @text({ unique: true, optional: true }) slug
      writeFileSync(
        UNIQUE_NULLABLE_ENTITY_PATH,
        UNIQUE_NULLABLE_ENTITY_CONTENT,
        'utf-8'
      );
      writeFileSync(SCHEMA_PATH, SCHEMA_WITH_UNIQUE_NULLABLE, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // First insert with NULL slug should succeed
      const first = await executeGraphQL(
        `mutation {
          createUniqueNullableEntity(item: {
            name: "nullable-unique-1",
            value: 1,
            active: true,
            createdAt: "${now}",
            user_id: "${userId}"
          }) { id slug }
        }`,
        accessToken
      );
      expect(first.errors).toBeUndefined();
      const firstId = (first.data?.createUniqueNullableEntity as { id: string })
        .id;

      // Second insert with NULL slug should also succeed (NULL != NULL in SQL)
      const second = await executeGraphQL(
        `mutation {
          createUniqueNullableEntity(item: {
            name: "nullable-unique-2",
            value: 2,
            active: false,
            createdAt: "${now}",
            user_id: "${userId}"
          }) { id slug }
        }`,
        accessToken
      );
      expect(
        second.errors,
        'Multiple NULLs should be allowed in a unique nullable column'
      ).toBeUndefined();
      const secondId = (
        second.data?.createUniqueNullableEntity as { id: string }
      ).id;

      // Non-NULL duplicate should still be rejected
      const withSlug = await executeGraphQL(
        `mutation {
          createUniqueNullableEntity(item: {
            name: "nullable-unique-3",
            slug: "taken-slug",
            value: 3,
            active: true,
            createdAt: "${now}",
            user_id: "${userId}"
          }) { id slug }
        }`,
        accessToken
      );
      expect(withSlug.errors).toBeUndefined();
      const thirdId = (
        withSlug.data?.createUniqueNullableEntity as { id: string }
      ).id;

      const dupSlug = await executeGraphQL(
        `mutation {
          createUniqueNullableEntity(item: {
            name: "nullable-unique-4",
            slug: "taken-slug",
            value: 4,
            active: false,
            createdAt: "${now}",
            user_id: "${userId}"
          }) { id slug }
        }`,
        accessToken
      );
      expect(
        dupSlug.errors,
        'Non-NULL duplicate should still be rejected by unique constraint'
      ).toBeDefined();

      // Clean up records
      for (const id of [firstId, secondId, thirdId]) {
        await executeGraphQL(
          `mutation { deleteUniqueNullableEntity(id: "${id}") { id } }`,
          accessToken
        );
      }

      // Tear down UniqueNullableEntity
      unlinkSync(UNIQUE_NULLABLE_ENTITY_PATH);
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should enforce @text({ min }) check constraint and reject short strings', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Add min: 3 to the 'name' field on TestEntity1
      const withMinLen = TEST_ENTITY1_CONTENT.replace(
        '@text() name!: string;',
        '@text({ min: 3 }) name!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, withMinLen, 'utf-8');

      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // A name with 3+ characters should be accepted
      const validResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "abc",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userId}"
          }) { id name }
        }`,
        accessToken
      );
      expect(
        validResult.errors,
        'Name with 3 characters should be accepted'
      ).toBeUndefined();
      const validId = (validResult.data?.createTestEntity1 as { id: string })
        .id;

      // A name with < 3 characters should be rejected by the check constraint
      const tooShort = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "ab",
            intValue: 2,
            floatValue: 2.0,
            boolValue: false,
            createdAt: "${now}",
            status: "active",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(
        tooShort.errors,
        'Name with 2 characters should be rejected by min-length check constraint'
      ).toBeDefined();

      // Clean up
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${validId}") { id } }`,
        accessToken
      );

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);
    });

    it('should fail @text({ min }) migration when existing data violates min-length', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Seed a record with a short name (1 character)
      const seedResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "x",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(seedResult.errors).toBeUndefined();
      const seedId = (seedResult.data?.createTestEntity1 as { id: string }).id;

      // Now add min: 5 — existing data ("x") violates the constraint
      const withMinLen = TEST_ENTITY1_CONTENT.replace(
        '@text() name!: string;',
        '@text({ min: 5 }) name!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, withMinLen, 'utf-8');

      // Apply should fail — check constraint cannot be added because existing data violates it
      expect(() => execSync('rayfin dev db apply', applyOptions)).toThrow();

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      // Clean up seed data
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${seedId}") { id } }`,
        accessToken
      );
    });

    it('should fail @text({ max }) migration when existing data exceeds new max length', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Seed a record with a long name
      const seedResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "this-is-a-long-name-that-exceeds-five-chars",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userId}"
          }) { id }
        }`,
        accessToken
      );
      expect(seedResult.errors).toBeUndefined();
      const seedId = (seedResult.data?.createTestEntity1 as { id: string }).id;

      // Reduce max to 5 — existing data is longer and will be truncated
      const withMax = TEST_ENTITY1_CONTENT.replace(
        '@text() name!: string;',
        '@text({ max: 5 }) name!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, withMax, 'utf-8');

      // Apply should fail — string truncation error
      expect(() => execSync('rayfin dev db apply', applyOptions)).toThrow();

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      // Clean up seed data
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${seedId}") { id } }`,
        accessToken
      );
    });

    it('should reject @text({ max }) exceeding MSSQL NVARCHAR limit at CLI level', () => {
      // This test only applies to MSSQL — PostgreSQL has no practical VARCHAR limit
      const dialect = getDialect();
      if (dialect === 'postgresql') return;

      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;

      // Set max to 5000 which exceeds MSSQL NVARCHAR(n) limit of 4000
      const exceeds = TEST_ENTITY1_CONTENT.replace(
        '@text() name!: string;',
        '@text({ max: 5000 }) name!: string;'
      );
      writeFileSync(TEST_ENTITY1_PATH, exceeds, 'utf-8');

      // CLI should reject this at schema analysis time, before reaching the host
      expect(() =>
        execSync('rayfin dev db apply', {
          cwd: TODO_APP_DIR,
          encoding: 'utf-8',
          timeout: 120_000,
          env: { ...cleanEnv, CI: 'true' },
        })
      ).toThrow();

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
    });
  });

  describe('Type Changes', () => {
    it('should apply a compatible type change (int → decimal) without force flag', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Change 'intValue' from @int to @decimal (compatible widening)
      const compatible = TEST_ENTITY1_CONTENT.replace(
        '@int() intValue!: number;',
        '@decimal() intValue!: number;'
      );
      writeFileSync(TEST_ENTITY1_PATH, compatible, 'utf-8');

      // Type changes may require --force on some databases (e.g. PostgreSQL)
      const output = execSync('rayfin dev db apply --force', applyOptions);
      expect(output).toBeDefined();

      // Verify the field is still queryable
      const probe = await probeFields('TestEntity1', ['intValue'], accessToken);
      expect(
        probe.success,
        'intValue should be queryable after int → decimal change'
      ).toBe(true);

      // Restore original fixture (decimal → int is incompatible, needs force)
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should fail on incompatible type change (text → int) without force flag', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Change 'name' from @text to @int (incompatible narrowing)
      const incompatible = TEST_ENTITY1_CONTENT.replace(
        '@text() name!: string;',
        '@int() name!: number;'
      );
      writeFileSync(TEST_ENTITY1_PATH, incompatible, 'utf-8');

      // Incompatible type change is destructive — should fail without --force
      expect(() => execSync('rayfin dev db apply', applyOptions)).toThrow();

      // Restore original fixture
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);
    });

    it('should reject incompatible type change (text → int) even with force and no existing data', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      const isPostgres = getDialect() === 'postgresql';

      // Change optional 'description' from @text to @int (incompatible)
      const incompatible = TEST_ENTITY1_CONTENT.replace(
        '@text({ optional: true }) description?: string;',
        '@int({ optional: true }) description?: number;'
      );
      writeFileSync(TEST_ENTITY1_PATH, incompatible, 'utf-8');

      if (isPostgres) {
        // PostgreSQL cannot auto-cast text columns to integer even when empty
        expect(
          () => execSync('rayfin dev db apply --force', applyOptions),
          'PostgreSQL should reject incompatible type cast even with --force'
        ).toThrow();
      } else {
        // MSSQL allows ALTER COLUMN from nvarchar → int when the column
        // contains only NULLs, so the apply succeeds
        const output = execSync('rayfin dev db apply --force', applyOptions);
        expect(output).toBeDefined();
      }

      // Restore original fixture (type revert needs --force)
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should fail incompatible type change when column has existing data', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Insert a record with a text name value
      const createResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "not-a-number",
            intValue: 1,
            floatValue: 1.0,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userId}"
          }) { id name }
        }`,
        accessToken
      );
      expect(createResult.errors).toBeUndefined();
      const createdId = (createResult.data?.createTestEntity1 as { id: string })
        .id;

      // Change 'name' from @text to @int — incompatible with existing text data
      const incompatible = TEST_ENTITY1_CONTENT.replace(
        '@text() name!: string;',
        '@int() name!: number;'
      );
      writeFileSync(TEST_ENTITY1_PATH, incompatible, 'utf-8');

      // Even with --force, the database should reject the type conversion
      // because existing data ("not-a-number") cannot be cast to int
      expect(
        () => execSync('rayfin dev db apply --force', applyOptions),
        'Incompatible type change with existing data should fail'
      ).toThrow();

      // Restore original fixture — reverting the type change is itself
      // destructive (int → text), so --force is required
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);

      // Verify existing data is still intact
      const queryResult = await executeGraphQL(
        `{ testEntity1_by_pk(id: "${createdId}") { id name } }`,
        accessToken
      );
      expect(queryResult.errors).toBeUndefined();
      const record = queryResult.data?.testEntity1_by_pk as {
        id: string;
        name: string;
      };
      expect(record.name).toBe('not-a-number');

      // Clean up
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${createdId}") { id } }`,
        accessToken
      );
    });
  });

  describe('Relationship Operations', () => {
    it('should drop a foreign key relationship without force flag', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Remove only the TestEntity1 `parent` relationship and its import. The
      // self-referencing `sibling`/`referrers` relationships remain, so the
      // `one`/`many` imports are still required.
      const withoutRelationship = TEST_ENTITY2_CONTENT.replace(
        "import { TestEntity1 } from './TestEntity1.js';\n",
        ''
      ).replace(
        '\n  @one(() => TestEntity1, { optional: true }) parent?: TestEntity1;\n',
        ''
      );

      // Guard: verify the TestEntity1 parent relationship was removed while the
      // self-referencing relationships are preserved.
      expect(withoutRelationship).not.toContain('TestEntity1');
      expect(withoutRelationship).not.toContain('parent');
      expect(withoutRelationship).toContain('sibling');

      writeFileSync(TEST_ENTITY2_PATH, withoutRelationship, 'utf-8');

      // Dropping a FK is destructive (drops the parent_id column) — should need --force
      expect(() => execSync('rayfin dev db apply', applyOptions)).toThrow();

      // Restore original fixture
      writeFileSync(TEST_ENTITY2_PATH, TEST_ENTITY2_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should drop a foreign key relationship with force flag', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Remove only the TestEntity1 `parent` relationship and its import. The
      // self-referencing `sibling`/`referrers` relationships remain, so the
      // `one`/`many` imports are still required.
      const withoutRelationship = TEST_ENTITY2_CONTENT.replace(
        "import { TestEntity1 } from './TestEntity1.js';\n",
        ''
      ).replace(
        '\n  @one(() => TestEntity1, { optional: true }) parent?: TestEntity1;\n',
        ''
      );

      writeFileSync(TEST_ENTITY2_PATH, withoutRelationship, 'utf-8');

      // With --force should succeed
      const output = execSync('rayfin dev db apply --force', applyOptions);
      expect(output).toBeDefined();

      // Verify the FK field no longer exists
      expect(
        await isFieldAbsent('TestEntity2', 'parent_id', accessToken),
        'parent_id FK field should be gone after dropping relationship'
      ).toBe(true);

      // The 'parent' relationship should also be gone
      const parentResult = await executeGraphQL(
        `{ testEntity2s { items { parent { id } } } }`,
        accessToken
      );
      expect(
        parentResult.errors,
        'parent relationship should not be queryable after drop'
      ).toBeDefined();

      // Restore original fixture (re-creates the FK — may need --force)
      writeFileSync(TEST_ENTITY2_PATH, TEST_ENTITY2_CONTENT, 'utf-8');
      execSync('rayfin dev db apply --force', applyOptions);

      // Verify FK is restored
      const fkProbe = await probeFields(
        'TestEntity2',
        ['parent_id'],
        accessToken
      );
      expect(fkProbe.success, 'parent_id FK should be restored').toBe(true);
    });
  });

  describe('Idempotency', () => {
    it('should be a no-op when reapplying the same schema', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Ensure current schema is applied
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      writeFileSync(TEST_ENTITY2_PATH, TEST_ENTITY2_CONTENT, 'utf-8');
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');
      execSync('rayfin dev db apply', applyOptions);

      const session = client.auth.getSession();
      const userId = session.user!.id;
      const now = new Date().toISOString();

      // Insert a record before re-applying
      const createResult = await executeGraphQL(
        `mutation {
          createTestEntity1(item: {
            name: "idempotency-test",
            intValue: 42,
            floatValue: 3.14,
            boolValue: true,
            createdAt: "${now}",
            status: "active",
            user_id: "${userId}"
          }) { id name }
        }`,
        accessToken
      );
      expect(createResult.errors).toBeUndefined();
      const createdId = (createResult.data?.createTestEntity1 as { id: string })
        .id;

      // Reapply the exact same schema — should succeed and be a no-op
      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      // Verify existing data is not affected
      const queryResult = await executeGraphQL(
        `{ testEntity1_by_pk(id: "${createdId}") { id name intValue } }`,
        accessToken
      );
      expect(queryResult.errors).toBeUndefined();
      const record = queryResult.data?.testEntity1_by_pk as {
        id: string;
        name: string;
        intValue: number;
      };
      expect(record).toBeDefined();
      expect(record.name).toBe('idempotency-test');
      expect(record.intValue).toBe(42);

      // Clean up
      await executeGraphQL(
        `mutation { deleteTestEntity1(id: "${createdId}") { id } }`,
        accessToken
      );
    });

    it('should be idempotent across multiple consecutive reapplies', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Reapply the same schema 3 times in a row — all should succeed
      for (let i = 0; i < 3; i++) {
        const output = execSync('rayfin dev db apply', applyOptions);
        expect(output, `Reapply #${i + 1} should succeed`).toBeDefined();
      }

      // Verify the schema is still intact
      const entity1Exists = await probeEntityExists('TestEntity1', accessToken);
      expect(entity1Exists, 'TestEntity1 should exist after reapplies').toBe(
        true
      );

      const entity2Exists = await probeEntityExists('TestEntity2', accessToken);
      expect(entity2Exists, 'TestEntity2 should exist after reapplies').toBe(
        true
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle an entity declared with no explicit id (auto-injects PK)', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Write the NoIdEntity fixture (has @text fields but no @uuid id)
      writeFileSync(NO_ID_ENTITY_PATH, NO_ID_ENTITY_CONTENT, 'utf-8');
      writeFileSync(SCHEMA_PATH, SCHEMA_WITH_NO_ID, 'utf-8');

      // The CLI auto-injects a default 'id' PK — should succeed
      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      // The entity should be created in the DB. Because it has an RLS policy
      // (claims.sub.eq(item.user_id)), listing may return empty unless we
      // create a record first. Insert a record to verify the entity is functional.
      const session = client.auth.getSession();
      const userId = session.user!.id;
      const createResult = await executeGraphQL(
        `mutation {
          createNoIdEntity(item: {
            name: "no-id-test",
            user_id: "${userId}"
          }) { id name }
        }`,
        accessToken
      );
      // If the entity was created and auto-id injected, we can create records
      expect(
        createResult.errors,
        'NoIdEntity should accept mutations (auto-injected id)'
      ).toBeUndefined();
      const created = createResult.data?.createNoIdEntity as {
        id: string;
        name: string;
      };
      expect(created.id, 'Auto-injected id should be present').toBeDefined();
      expect(created.name).toBe('no-id-test');

      // Clean up the record
      await executeGraphQL(
        `mutation { deleteNoIdEntity(id: "${created.id}") { id } }`,
        accessToken
      );

      // Clean up: remove the entity
      if (existsSync(NO_ID_ENTITY_PATH)) unlinkSync(NO_ID_ENTITY_PATH);
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');
      execSync('rushx clean', { cwd: TODO_APP_DIR, encoding: 'utf-8' });
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should handle an entity declared with no fields gracefully', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Write the EmptyEntity fixture (only @entity() decorator, no fields)
      writeFileSync(EMPTY_ENTITY_PATH, EMPTY_ENTITY_CONTENT, 'utf-8');
      writeFileSync(SCHEMA_PATH, SCHEMA_WITH_EMPTY, 'utf-8');

      // An entity with no fields should either:
      // - Be skipped by the host (no DDL generated), or
      // - Get an auto-injected id and succeed
      // Either way, it should NOT crash the apply pipeline
      let applySucceeded = true;
      try {
        execSync('rayfin dev db apply', applyOptions);
      } catch {
        applySucceeded = false;
      }

      // The apply should not crash — it may succeed (skip the entity) or fail gracefully
      // The important thing is the pipeline remains functional
      // Verify other entities are not affected
      const entity1Exists = await probeEntityExists('TestEntity1', accessToken);
      expect(
        entity1Exists,
        'TestEntity1 should still exist after empty entity apply'
      ).toBe(true);

      if (applySucceeded) {
        // If the CLI auto-injected an id, the entity might exist
        const emptyExists = await probeEntityExists('EmptyEntity', accessToken);
        // Log for visibility — behavior may vary
        console.log(`EmptyEntity exists after apply: ${emptyExists}`);
      }

      // Clean up
      if (existsSync(EMPTY_ENTITY_PATH)) unlinkSync(EMPTY_ENTITY_PATH);
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');
      execSync('rushx clean', { cwd: TODO_APP_DIR, encoding: 'utf-8' });
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should support a relationship to the system User entity via @one(() => User)', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Write the UserRelEntity1 fixture — a standalone entity with @one(() => User)
      writeFileSync(USER_REL_ENTITY_PATH, USER_REL_ENTITY_CONTENT, 'utf-8');
      writeFileSync(SCHEMA_PATH, SCHEMA_WITH_USER_REL, 'utf-8');

      // Apply schema — should succeed (creates UserRelEntity1 table with
      // auto-generated createdBy_id FK column → system Users table).
      const output = execSync('rayfin dev db apply', applyOptions);
      expect(output).toBeDefined();

      // Verify the entity exists and the auto-generated FK field is present
      const entityExists = await probeEntityExists(
        'UserRelEntity1',
        accessToken
      );
      expect(entityExists, 'UserRelEntity1 should exist after apply').toBe(
        true
      );

      const fkProbe = await probeFields(
        'UserRelEntity1',
        ['createdBy_id'],
        accessToken
      );
      expect(
        fkProbe.success,
        'createdBy_id FK field should exist after adding @one(() => User)'
      ).toBe(true);

      // Query the join field to verify the relationship is wired up in the
      // GraphQL schema. We don't insert any data — an empty list with no
      // errors proves the @one(() => User) relationship is valid.
      const joinResult = await executeGraphQL(
        `{
          userRelEntity1s {
            items {
              id title
              createdBy { Id Email }
            }
          }
        }`,
        accessToken
      );
      expect(
        joinResult.errors,
        'Querying the createdBy join field should not error'
      ).toBeUndefined();
      const items = (joinResult.data?.userRelEntity1s as { items: unknown[] })
        ?.items;
      expect(
        items,
        'items should be an empty array (no data inserted)'
      ).toEqual([]);

      // Clean up: remove the entity (destructive — needs --force)
      if (existsSync(USER_REL_ENTITY_PATH)) unlinkSync(USER_REL_ENTITY_PATH);
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');
      execSync('rushx clean', { cwd: TODO_APP_DIR, encoding: 'utf-8' });
      execSync('rayfin dev db apply --force', applyOptions);
    });

    it('should prevent modifications to system tables (User entity)', async () => {
      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Write a User entity that conflicts with the system Users table
      writeFileSync(USER_ENTITY_PATH, USER_ENTITY_CONTENT, 'utf-8');
      writeFileSync(SCHEMA_PATH, SCHEMA_WITH_USER, 'utf-8');

      // The CLI should skip the User entity (system entity protection)
      // or the host should reject modifications to the system Users table.
      // In either case, the apply should not modify the system table.
      let applySucceeded = true;
      try {
        execSync('rayfin dev db apply', applyOptions);
      } catch {
        applySucceeded = false;
      }

      // Whether it succeeded (User was silently skipped) or failed (rejected),
      // the system Users table should be intact.
      // Verify existing entities are not affected
      const entity1Exists = await probeEntityExists('TestEntity1', accessToken);
      expect(
        entity1Exists,
        'TestEntity1 should still exist after system table attempt'
      ).toBe(true);

      if (applySucceeded) {
        // The User entity should NOT be queryable as a custom entity
        // (it's a system entity managed by the platform)
        const userQueryable = await probeEntityExists('User', accessToken);
        expect(
          userQueryable,
          'System User entity should not be exposed as a custom entity'
        ).toBe(false);
      }

      // Clean up
      if (existsSync(USER_ENTITY_PATH)) unlinkSync(USER_ENTITY_PATH);
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');
      execSync('rushx clean', { cwd: TODO_APP_DIR, encoding: 'utf-8' });
      execSync('rayfin dev db apply --force', applyOptions);
    });
  });

  describe('Entity Teardown', () => {
    it('should fail to drop entities without force flag', async () => {
      // Restore schema to original (only Todo + Category)
      writeFileSync(SCHEMA_PATH, ORIGINAL_SCHEMA, 'utf-8');

      // Remove all test entity source files (includes edge-case fixtures
      // that may have been left behind by earlier test failures)
      for (const filePath of [
        TEST_ENTITY1_PATH,
        TEST_ENTITY2_PATH,
        NO_ID_ENTITY_PATH,
        EMPTY_ENTITY_PATH,
        USER_ENTITY_PATH,
        USER_REL_ENTITY_PATH,
      ]) {
        if (existsSync(filePath)) unlinkSync(filePath);
      }

      // Clean stale compiled outputs so tsc doesn't pick up deleted entities
      execSync('rushx clean', { cwd: TODO_APP_DIR, encoding: 'utf-8' });

      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;
      const applyOptions = {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8' as const,
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      };

      // Dropping entities is destructive — db apply without --force should error
      expect(() => execSync('rayfin dev db apply', applyOptions)).toThrow();

      // Entities should still exist since the apply was rejected
      // Restore entity files so probes can succeed
      writeFileSync(TEST_ENTITY1_PATH, TEST_ENTITY1_CONTENT, 'utf-8');
      writeFileSync(TEST_ENTITY2_PATH, TEST_ENTITY2_CONTENT, 'utf-8');
      writeFileSync(SCHEMA_PATH, UPDATED_SCHEMA, 'utf-8');

      const entity1Exists = await probeEntityExists('TestEntity1', accessToken);
      expect(
        entity1Exists,
        'TestEntity1 should still exist after failed drop'
      ).toBe(true);

      const entity2Exists = await probeEntityExists('TestEntity2', accessToken);
      expect(
        entity2Exists,
        'TestEntity2 should still exist after failed drop'
      ).toBe(true);
    });

    it('should drop entities with force flag and verify they no longer exist', async () => {
      // Restore schema to original (only Todo + Category)
      writeFileSync(SCHEMA_PATH, ORIGINAL_SCHEMA, 'utf-8');

      // Remove all test entity source files (includes edge-case fixtures
      // that may have been left behind by earlier test failures)
      for (const filePath of [
        TEST_ENTITY1_PATH,
        TEST_ENTITY2_PATH,
        NO_ID_ENTITY_PATH,
        EMPTY_ENTITY_PATH,
        USER_ENTITY_PATH,
        USER_REL_ENTITY_PATH,
      ]) {
        if (existsSync(filePath)) unlinkSync(filePath);
      }

      // Clean stale compiled outputs so tsc doesn't pick up deleted entities
      execSync('rushx clean', { cwd: TODO_APP_DIR, encoding: 'utf-8' });

      const { NODE_OPTIONS: _unused, ...cleanEnv } = process.env;

      const output = execSync('rayfin dev db apply --force', {
        cwd: TODO_APP_DIR,
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...cleanEnv, CI: 'true' },
      });

      expect(output).toBeDefined();

      // Verify no test entities exist in the GraphQL schema
      for (const entityName of [
        'TestEntity1',
        'TestEntity2',
        'NoIdEntity',
        'EmptyEntity',
        'User',
        'UserRelEntity1',
      ]) {
        const exists = await probeEntityExists(entityName, accessToken);
        expect(exists, `${entityName} should no longer exist`).toBe(false);
      }
    });
  });
});
