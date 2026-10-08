import { describe, it, expect, beforeAll } from 'vitest';

import { DatabaseDialect } from '../analysis/dialect-config';
import { SchemaAnalyzer } from '../analysis/schema-analyzer';
import {
  STORAGE_CONFIG_SCHEMA_VERSION,
  StorageConfigGenerator,
} from '../analysis/storage-config-generator';
import {
  blob,
  StorageObject,
  mb,
  kb,
  ContentTypes,
} from '../experimental/index';
import { boolean, int, role, text, uuid } from '../index';

// Suppress console.log during tests
beforeAll(() => {
  console.log = () => {};
});

// ============================================================================
// BASIC STORAGE TESTS
// ============================================================================

describe('StorageConfigGenerator - Basic', () => {
  @blob('uploads')
  @role('authenticated', ['create', 'read', 'delete'])
  class FileModel {}

  @blob()
  @role('authenticated', 'read')
  class DocumentStorage {}

  it('emits the JSON DSL envelope with schemaVersion and folders array', () => {
    const analyzer = new SchemaAnalyzer(
      [FileModel, DocumentStorage],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.schemaVersion).toBe(STORAGE_CONFIG_SCHEMA_VERSION);
    expect(Array.isArray(config.folders)).toBe(true);
    // Folders are emitted sorted by normalized name ('documentstorage' < 'uploads').
    expect(config.folders).toEqual([
      {
        name: 'documentstorage',
        displayName: 'DocumentStorage',
        onConflict: 'error',
        rules: [
          { pathPattern: '**', role: 'authenticated', actions: ['read'] },
        ],
      },
      {
        name: 'uploads',
        displayName: 'FileModel',
        onConflict: 'error',
        rules: [
          {
            pathPattern: '**',
            role: 'authenticated',
            actions: ['create', 'read', 'delete'],
          },
        ],
      },
    ]);
  });

  it('sorts rules by role name for deterministic output', () => {
    const analyzer = new SchemaAnalyzer(
      [DocumentStorage],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);
    const roles = config.folders[0].rules.map((r) => r.role);
    expect(roles).toEqual(['authenticated']);
  });
});

// ============================================================================
// PERMISSION SHAPE TESTS
// ============================================================================

describe('StorageConfigGenerator - Rule shape', () => {
  it('emits pathPattern "**" for every rule (v1 root-level only)', () => {
    @blob('audit-logs')
    @role('authenticated', 'read')
    class AuditLogs {}

    const analyzer = new SchemaAnalyzer([AuditLogs], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules.every((r) => r.pathPattern === '**')).toBe(
      true
    );
  });

  it('flattens complex actions (with policy) to their action keyword', () => {
    @blob({ name: 'userstorage' })
    @role('authenticated', ['read', 'create', 'delete'], {
      policy: (claims, item) => claims.sub.eq(item.user_id),
    })
    class UserStorage {
      @text()
      user_id!: string;
    }

    const analyzer = new SchemaAnalyzer([UserStorage], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    const rule = config.folders[0].rules.find(
      (r) => r.role === 'authenticated'
    );
    expect(rule?.actions).toEqual(['create', 'read', 'delete']);
  });

  it('passes wildcard action through unchanged', () => {
    @blob('admin-files')
    @role('authenticated', '*')
    class AdminStorage {}

    const analyzer = new SchemaAnalyzer([AdminStorage], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules).toEqual([
      { pathPattern: '**', role: 'authenticated', actions: ['*'] },
    ]);
  });
});

// ============================================================================
// FOLDER NAME / DISPLAY NAME TESTS
// ============================================================================

describe('StorageConfigGenerator - Folder name and displayName', () => {
  @blob('custom-folder-name')
  @role('authenticated', 'read')
  class CustomNamedFolder {}

  @blob()
  @role('authenticated', 'read')
  class AutoNamedFolder {}

  it('uses explicit folder name as name and class name as displayName', () => {
    const analyzer = new SchemaAnalyzer(
      [CustomNamedFolder],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].name).toBe('custom-folder-name');
    expect(config.folders[0].displayName).toBe('CustomNamedFolder');
  });

  it('lowercases the class name when no explicit folder name is given', () => {
    const analyzer = new SchemaAnalyzer(
      [AutoNamedFolder],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].name).toBe('autonamedfolder');
    expect(config.folders[0].displayName).toBe('AutoNamedFolder');
  });
});

// ============================================================================
// @blob OPTIONS PROPAGATION TESTS
// ============================================================================

describe('StorageConfigGenerator - @blob options', () => {
  it("defaults onConflict to 'error' when not set", () => {
    @blob('plain')
    @role('authenticated', 'read')
    class Plain {}

    const analyzer = new SchemaAnalyzer([Plain], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].onConflict).toBe('error');
  });

  it("propagates explicit onConflict: 'overwrite'", () => {
    @blob({ name: 'avatars', onConflict: 'overwrite' })
    @role('authenticated', ['create', 'read', 'update', 'delete'])
    class Avatars {}

    const analyzer = new SchemaAnalyzer([Avatars], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].onConflict).toBe('overwrite');
  });

  it('emits maxSize (normalized to bytes) and allowedContentTypes when set', () => {
    @blob({
      name: 'avatars',
      maxSize: '2mb',
      allowedContentTypes: ['image/*'],
    })
    @role('authenticated', '*')
    class Avatars {}

    const analyzer = new SchemaAnalyzer([Avatars], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].maxSize).toBe(2 * 1024 * 1024);
    expect(config.folders[0].allowedContentTypes).toEqual(['image/*']);
  });

  it('accepts a raw byte number for maxSize', () => {
    @blob({ name: 'attachments', maxSize: 1024 })
    @role('authenticated', '*')
    class Attachments {}

    const analyzer = new SchemaAnalyzer([Attachments], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].maxSize).toBe(1024);
  });

  it('omits maxSize and allowedContentTypes for an unconstrained folder', () => {
    @blob('files')
    @role('authenticated', '*')
    class Files {}

    const analyzer = new SchemaAnalyzer([Files], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].maxSize).toBeUndefined();
    expect(config.folders[0].allowedContentTypes).toBeUndefined();
  });

  it('byte-size helpers and ContentTypes constants produce valid emitted values', () => {
    expect(mb(2)).toBe(2 * 1024 * 1024);
    expect(kb(500)).toBe(500 * 1024);

    @blob({
      name: 'avatars-helper',
      maxSize: mb(2),
      allowedContentTypes: [ContentTypes.AnyImage, ContentTypes.Png],
    })
    @role('authenticated', '*')
    class AvatarsHelper {}

    const analyzer = new SchemaAnalyzer([AvatarsHelper], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].maxSize).toBe(2 * 1024 * 1024);
    expect(config.folders[0].allowedContentTypes).toEqual([
      'image/*',
      'image/png',
    ]);
  });
});

// ============================================================================
// VALIDATION RULES (rules 6, 7 & 8)
// ============================================================================

describe('StorageConfigGenerator - Validation rules', () => {
  it('rule 6: rejects anonymous permissions', () => {
    @blob('owned-public-writes')
    @role('anonymous', ['read', 'create'])
    class OwnedPublicWrites {}

    const analyzer = new SchemaAnalyzer(
      [OwnedPublicWrites],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /anonymous permissions are not supported for storage folders/
    );
  });

  it('rule 6: rejects anonymous read', () => {
    @blob('owned-public-read')
    @role('anonymous', 'read')
    @role('authenticated', ['create', 'read'])
    class OwnedPublicRead {}

    const analyzer = new SchemaAnalyzer(
      [OwnedPublicRead],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /anonymous permissions are not supported/
    );
  });

  it('rule 6: rejects anonymous write permissions', () => {
    @blob({ name: 'shared-writes' })
    @role('anonymous', ['read', 'create'])
    class SharedWrites {}

    const analyzer = new SchemaAnalyzer([SharedWrites], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /anonymous permissions are not supported/
    );
  });

  it("rule 7: onConflict 'overwrite' requires at least one non-anonymous role to grant update", () => {
    @blob({ name: 'no-update-overwrite', onConflict: 'overwrite' })
    @role('authenticated', ['create', 'read', 'delete'])
    class NoUpdateOverwrite {}

    const analyzer = new SchemaAnalyzer(
      [NoUpdateOverwrite],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /onConflict: 'overwrite' requires.*'update'/
    );
  });

  it("rule 7: passes when onConflict is 'overwrite' and at least one role grants update", () => {
    @blob({ name: 'updatable', onConflict: 'overwrite' })
    @role('authenticated', ['create', 'read', 'update'])
    class Updatable {}

    const analyzer = new SchemaAnalyzer([Updatable], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() =>
      new StorageConfigGenerator().generateConfig(folders)
    ).not.toThrow();
  });

  it("rule 7: anonymous 'update' alone does not satisfy the requirement", () => {
    // Anonymous permissions are rejected before overwrite validation.
    @blob({
      name: 'anon-update-only',
      onConflict: 'overwrite',
    })
    @role('anonymous', ['read', 'create', 'update'])
    class AnonUpdateOnly {}

    const analyzer = new SchemaAnalyzer(
      [AnonUpdateOnly],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /anonymous permissions are not supported/
    );
  });

  it("rule 7: wildcard '*' role satisfies the overwrite update requirement", () => {
    // `'*'` grants all actions including update, so overwrite is allowed.
    @blob({ name: 'wildcard-overwrite', onConflict: 'overwrite' })
    @role('authenticated', '*')
    class WildcardOverwrite {}

    const analyzer = new SchemaAnalyzer(
      [WildcardOverwrite],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() =>
      new StorageConfigGenerator().generateConfig(folders)
    ).not.toThrow();
  });

  it("rule 6: rejects wildcard '*' anonymous permissions", () => {
    @blob('owned-wildcard-anon')
    @role('anonymous', '*')
    class OwnedWildcardAnon {}

    const analyzer = new SchemaAnalyzer(
      [OwnedWildcardAnon],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /anonymous permissions are not supported/
    );
  });

  it('rule 8: rejects a non-positive maxSize', () => {
    @blob({ name: 'bad-size', maxSize: 0 })
    @role('authenticated', '*')
    class BadSize {}

    const analyzer = new SchemaAnalyzer([BadSize], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /maxSize must be a positive whole byte count/
    );
  });

  it('rule 8: rejects a fractional maxSize byte count', () => {
    @blob({ name: 'frac-size', maxSize: 10.5 })
    @role('authenticated', '*')
    class FracSize {}

    const analyzer = new SchemaAnalyzer([FracSize], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /maxSize must be a positive whole byte count/
    );
  });

  it('rule 8: rejects a malformed maxSize string', () => {
    // Cast bypasses the compile-time `ByteSize` type to exercise the runtime
    // validator (e.g., a value reaching the decorator from untyped JS).
    @blob({ name: 'bad-size-str', maxSize: 'huge' as unknown as number })
    @role('authenticated', '*')
    class BadSizeStr {}

    const analyzer = new SchemaAnalyzer([BadSizeStr], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /maxSize must be a positive whole byte count/
    );
  });

  it('rule 8: rejects a maxSize above the single-upload ceiling', () => {
    // 5,000 MiB is the max; one byte over must be rejected.
    @blob({ name: 'too-big', maxSize: 5_000 * 1024 * 1024 + 1 })
    @role('authenticated', '*')
    class TooBig {}

    const analyzer = new SchemaAnalyzer([TooBig], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /exceeds the maximum supported object size/
    );
  });

  it('rule 8: accepts a maxSize exactly at the single-upload ceiling', () => {
    @blob({ name: 'at-limit', maxSize: 5_000 * 1024 * 1024 })
    @role('authenticated', '*')
    class AtLimit {}

    const analyzer = new SchemaAnalyzer([AtLimit], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);
    expect(config.folders[0].maxSize).toBe(5_000 * 1024 * 1024);
  });

  it('rule 8: rejects an over-ceiling maxSize expressed as a size string', () => {
    // Exercises the string/unit parse branch against the cap: 6gb (6 GiB) is
    // above the 5,000 MiB (~4.88 GiB) single-upload ceiling.
    @blob({ name: 'too-big-str', maxSize: '6gb' })
    @role('authenticated', '*')
    class TooBigStr {}

    const analyzer = new SchemaAnalyzer([TooBigStr], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /exceeds the maximum supported object size/
    );
  });

  it('rule 8: rejects a malformed MIME glob in allowedContentTypes', () => {
    // Cast bypasses the compile-time `MimeGlob` type to exercise the runtime
    // validator (e.g., a value reaching the decorator from untyped JS).
    @blob({
      name: 'bad-mime',
      allowedContentTypes: ['image', 'application/pdf'] as any,
    })
    @role('authenticated', '*')
    class BadMime {}

    const analyzer = new SchemaAnalyzer([BadMime], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /malformed MIME glob\(s\): image/
    );
  });

  it('rule 8: accepts valid MIME globs and size strings', () => {
    @blob({
      name: 'good-constraints',
      maxSize: '500kb',
      allowedContentTypes: ['image/*', 'application/pdf'],
    })
    @role('authenticated', '*')
    class GoodConstraints {}

    const analyzer = new SchemaAnalyzer(
      [GoodConstraints],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() =>
      new StorageConfigGenerator().generateConfig(folders)
    ).not.toThrow();
  });
});

// ============================================================================
// CHECK AST EMISSION (the storage service consumes structured AST,
// not the DAB-style policy string).
// ============================================================================

describe('StorageConfigGenerator - check AST emission', () => {
  it('emits a simple eq check comparing claims.sub to an item field', () => {
    @blob({ name: 'owned-files' })
    @role('authenticated', ['read', 'delete'], {
      policy: (claims, item) => claims.sub.eq(item.owner_id),
    })
    class OwnedFiles {
      owner_id!: string;
    }

    const analyzer = new SchemaAnalyzer([OwnedFiles], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules).toEqual([
      {
        pathPattern: '**',
        role: 'authenticated',
        actions: ['read', 'delete'],
        check: {
          op: 'eq',
          lhs: { claim: 'sub' },
          rhs: { field: 'owner_id' },
        },
      },
    ]);
  });

  it('emits a neq check when the policy lambda uses .neq()', () => {
    @blob({ name: 'not-yours' })
    @role('authenticated', 'read', {
      policy: (claims, item) => claims.sub.neq(item.owner_id),
    })
    class NotYours {
      owner_id!: string;
    }

    const analyzer = new SchemaAnalyzer([NotYours], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'neq',
      lhs: { claim: 'sub' },
      rhs: { field: 'owner_id' },
    });
  });

  it('emits an and-tree for combined predicates', () => {
    @blob({ name: 'team-files' })
    @role('authenticated', 'read', {
      policy: (claims, item) =>
        claims.sub.eq(item.owner_id).and(claims.role.eq('member')),
    })
    class TeamFiles {
      owner_id!: string;
    }

    const analyzer = new SchemaAnalyzer([TeamFiles], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'and',
      args: [
        { op: 'eq', lhs: { claim: 'sub' }, rhs: { field: 'owner_id' } },
        { op: 'eq', lhs: { claim: 'role' }, rhs: 'member' },
      ],
    });
  });

  it('emits an or-tree for disjunctive predicates', () => {
    @blob({ name: 'shared-or-owned' })
    @role('authenticated', 'read', {
      policy: (claims, item) =>
        claims.sub.eq(item.owner_id).or(claims.role.eq('admin')),
    })
    class SharedOrOwned {
      owner_id!: string;
    }

    const analyzer = new SchemaAnalyzer([SharedOrOwned], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'or',
      args: [
        { op: 'eq', lhs: { claim: 'sub' }, rhs: { field: 'owner_id' } },
        { op: 'eq', lhs: { claim: 'role' }, rhs: 'admin' },
      ],
    });
  });

  it('omits check on rules whose action carries no policy', () => {
    @blob({ name: 'mixed-policy' })
    @role('authenticated', 'create')
    @role('authenticated', 'read', {
      policy: (claims, item) => claims.sub.eq(item.owner_id),
    })
    class MixedPolicy {
      owner_id!: string;
    }

    const analyzer = new SchemaAnalyzer([MixedPolicy], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    const withoutCheck = config.folders[0].rules.find((r) => !r.check);
    const withCheck = config.folders[0].rules.find((r) => r.check);
    expect(withoutCheck?.actions).toEqual(['create']);
    expect(withCheck?.actions).toEqual(['read']);
  });

  it('splits a role into multiple rules when its actions carry distinct checks', () => {
    @blob({ name: 'split-checks' })
    @role('authenticated', 'read', {
      policy: (claims, item) => claims.sub.eq(item.owner_id),
    })
    @role('authenticated', 'delete', {
      policy: (claims, _item) => claims.role.eq('admin'),
    })
    class SplitChecks {
      owner_id!: string;
    }

    const analyzer = new SchemaAnalyzer([SplitChecks], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    const authRules = config.folders[0].rules.filter(
      (r) => r.role === 'authenticated'
    );
    expect(authRules).toHaveLength(2);
    // Order between rules is keyed off JSON-serialized checks; assert by
    // content rather than position.
    const ownerRule = authRules.find(
      (r) =>
        r.check &&
        'lhs' in r.check &&
        'claim' in r.check.lhs &&
        r.check.lhs.claim === 'sub'
    );
    const adminRule = authRules.find(
      (r) =>
        r.check &&
        'lhs' in r.check &&
        'claim' in r.check.lhs &&
        r.check.lhs.claim === 'role'
    );
    expect(ownerRule?.actions).toEqual(['read']);
    expect(adminRule?.actions).toEqual(['delete']);
  });

  it('groups two actions with identical checks into one rule', () => {
    @blob({ name: 'grouped-checks' })
    @role('authenticated', ['read', 'delete'], {
      policy: (claims, item) => claims.sub.eq(item.owner_id),
    })
    class GroupedChecks {
      owner_id!: string;
    }

    const analyzer = new SchemaAnalyzer([GroupedChecks], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules).toHaveLength(1);
    expect(config.folders[0].rules[0]).toEqual({
      pathPattern: '**',
      role: 'authenticated',
      actions: ['read', 'delete'],
      check: {
        op: 'eq',
        lhs: { claim: 'sub' },
        rhs: { field: 'owner_id' },
      },
    });
  });

  it('serializes string literal RHS values verbatim (no quote escaping)', () => {
    @blob({ name: 'role-gated' })
    @role('authenticated', 'read', {
      policy: (claims) => claims.role.eq("o'admin"),
    })
    class RoleGated {}

    const analyzer = new SchemaAnalyzer([RoleGated], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'eq',
      lhs: { claim: 'role' },
      rhs: "o'admin",
    });
  });
});

// ============================================================================
// CHECK AST LITERAL & SHAPE COVERAGE (confirms every operand
// kind in the canonical grammar round-trips through the serializer with the
// expected wire shape).
// ============================================================================

describe('StorageConfigGenerator - check AST literal and shape coverage', () => {
  it('serializes number literal RHS as a JSON number', () => {
    @blob({ name: 'numeric-policy' })
    @role('authenticated', 'read', {
      policy: (_claims, item) => item.priority.eq(0),
    })
    class NumericPolicy {
      @int()
      priority!: number;
    }

    const analyzer = new SchemaAnalyzer([NumericPolicy], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'eq',
      lhs: { field: 'priority' },
      rhs: 0,
    });
  });

  it('serializes boolean literal RHS as a JSON boolean', () => {
    @blob({ name: 'flag-policy' })
    @role('authenticated', 'read', {
      policy: (_claims, item) => item.is_public.eq(true),
    })
    class FlagPolicy {
      @boolean()
      is_public!: boolean;
    }

    const analyzer = new SchemaAnalyzer([FlagPolicy], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'eq',
      lhs: { field: 'is_public' },
      rhs: true,
    });
  });

  it('serializes null literal RHS as JSON null', () => {
    @blob({ name: 'nullable-policy' })
    @role('authenticated', 'read', {
      policy: (_claims, item) => item.deleted_at.eq(null),
    })
    class NullablePolicy {
      @text({ optional: true })
      deleted_at?: string;
    }

    const analyzer = new SchemaAnalyzer(
      [NullablePolicy],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'eq',
      lhs: { field: 'deleted_at' },
      rhs: null,
    });
  });

  it('normalizes Date RHS to an ISO-8601 string', () => {
    @blob({ name: 'time-bounded' })
    @role('authenticated', 'read', {
      policy: (_claims, item) =>
        item.published_at.eq(new Date('2025-01-12T10:00:00.000Z')),
    })
    class TimeBounded {
      @text()
      published_at!: string;
    }

    const analyzer = new SchemaAnalyzer([TimeBounded], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'eq',
      lhs: { field: 'published_at' },
      rhs: '2025-01-12T10:00:00.000Z',
    });
  });

  it('supports field LHS with claim RHS (reverse direction of the canonical eq)', () => {
    @blob({ name: 'reverse-direction' })
    @role('authenticated', 'read', {
      policy: (claims, item) => item.owner_id.eq(claims.sub),
    })
    class ReverseDirection {
      owner_id!: string;
    }

    const analyzer = new SchemaAnalyzer(
      [ReverseDirection],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'eq',
      lhs: { field: 'owner_id' },
      rhs: { claim: 'sub' },
    });
  });

  it('preserves nesting depth when combinators are nested (and-of-or)', () => {
    @blob({ name: 'nested-policy' })
    @role('authenticated', 'read', {
      policy: (claims, item) =>
        claims.sub
          .eq(item.owner_id)
          .and(claims.role.eq('admin').or(claims.role.eq('member'))),
    })
    class NestedPolicy {
      owner_id!: string;
    }

    const analyzer = new SchemaAnalyzer([NestedPolicy], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].rules[0].check).toEqual({
      op: 'and',
      args: [
        { op: 'eq', lhs: { claim: 'sub' }, rhs: { field: 'owner_id' } },
        {
          op: 'or',
          args: [
            { op: 'eq', lhs: { claim: 'role' }, rhs: 'admin' },
            { op: 'eq', lhs: { claim: 'role' }, rhs: 'member' },
          ],
        },
      ],
    });
  });
});

// ============================================================================
// APP-SPECIFIC TYPED FIELDS — verifies that field
// decorators on a `@blob` class flow through metadata → analyzer →
// generator and surface as `fields[]` in the emitted JSON DSL, with each
// entry pinned to `storage: 'user_metadata'`.
// ============================================================================

describe('StorageConfigGenerator - app-specific typed fields', () => {
  it('emits fields[] for typed fields declared on a @blob class', () => {
    @blob('team-files')
    @role('authenticated', '*', {
      policy: (claims, item) => claims.sub.eq(item.team_ref),
    })
    class TeamFiles {
      @uuid()
      team_ref!: string;

      @text()
      team_id!: string;
    }

    const analyzer = new SchemaAnalyzer([TeamFiles], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].fields).toEqual([
      {
        name: 'team_ref',
        type: 'string',
        nullable: false,
        storage: 'user_metadata',
      },
      {
        name: 'team_id',
        type: 'string',
        nullable: false,
        storage: 'user_metadata',
      },
    ]);
  });

  it('marks fields declared with { optional: true } as nullable', () => {
    @blob('docs-with-notes')
    @role('authenticated', 'read')
    class DocsWithNotes {
      @text()
      title!: string;

      @text({ optional: true })
      notes?: string;
    }

    const analyzer = new SchemaAnalyzer([DocsWithNotes], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    const byName = Object.fromEntries(
      (config.folders[0].fields ?? []).map((f) => [f.name, f])
    );
    expect(byName.title.nullable).toBe(false);
    expect(byName.notes.nullable).toBe(true);
  });

  it('omits the fields property when the @blob class declares no typed fields', () => {
    @blob('plain-uploads')
    @role('authenticated', '*')
    class PlainUploads {}

    const analyzer = new SchemaAnalyzer([PlainUploads], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders[0].fields).toBeUndefined();
  });
});

// ============================================================================
// VALIDATION RULES 2, 3, 5 — additional fail-fast checks on top of
// the existing rule 6/7 coverage.
// ============================================================================

describe('StorageConfigGenerator - rule 2 (unknown field references)', () => {
  it('throws when a role policy references a field that is neither intrinsic nor declared', () => {
    @blob({ name: 'unknown-field' })
    @role('authenticated', 'read', {
      policy: (claims, item) => claims.sub.eq(item.not_declared),
    })
    class UnknownField {
      // Type-only declaration so the policy lambda compiles; the absence of
      // a field decorator is what makes rule 2 reject `item.not_declared`.
      declare not_declared: string;
    }

    const analyzer = new SchemaAnalyzer([UnknownField], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /references unknown field 'item\.not_declared'/
    );
  });

  it('accepts references to intrinsic StorageObject fields without a decorator', () => {
    @blob({ name: 'owner-policy' })
    @role('authenticated', 'read', {
      policy: (claims, item) => claims.sub.eq(item.owner_id),
    })
    class OwnerPolicy {
      declare owner_id: string;
    }

    const analyzer = new SchemaAnalyzer([OwnerPolicy], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() =>
      new StorageConfigGenerator().generateConfig(folders)
    ).not.toThrow();
  });

  it('accepts references to fields declared via field decorators on the @blob class', () => {
    @blob({ name: 'app-field' })
    @role('authenticated', 'read', {
      policy: (claims, item) => claims.sub.eq(item.team_id),
    })
    class AppField {
      @text()
      team_id!: string;
    }

    const analyzer = new SchemaAnalyzer([AppField], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() =>
      new StorageConfigGenerator().generateConfig(folders)
    ).not.toThrow();
  });

  it('rejects a policy field reference that differs only by case (references are case-sensitive)', () => {
    // The policy DSL derives field names from the exact `item.<prop>` access,
    // so field references are case-sensitive by design. A mis-cased reference
    // to an otherwise-declared field is an unknown-field error, not a match.
    @blob({ name: 'case-field' })
    @role('authenticated', 'read', {
      policy: (claims, item) => claims.sub.eq((item as any).Team_Id),
    })
    class CaseField {
      @text()
      team_id!: string;
    }

    const analyzer = new SchemaAnalyzer([CaseField], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /unknown field 'item\.Team_Id'/
    );
  });

  it('resolves intrinsic field refs in a policy when the @blob class extends StorageObject', () => {
    @blob({ name: 'intrinsic-policy' })
    @role('authenticated', '*', {
      policy: (claims, item) => claims.sub.eq(item.owner_id),
    })
    class IntrinsicPolicy extends StorageObject {
      @text() team_id!: string;
    }

    const analyzer = new SchemaAnalyzer(
      [IntrinsicPolicy],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    // The intrinsic `owner_id` resolves (rule 2) and serializes into the AST.
    expect(config.folders[0].rules[0].check).toEqual({
      op: 'eq',
      lhs: { claim: 'sub' },
      rhs: { field: 'owner_id' },
    });
    // The intrinsic is NOT registered as a user_metadata field (only the
    // decorated `team_id` is), so extending StorageObject adds no columns.
    expect(config.folders[0].fields).toEqual([
      {
        name: 'team_id',
        type: 'string',
        nullable: false,
        storage: 'user_metadata',
      },
    ]);
  });

  it('emits folders sorted by normalized name regardless of class-discovery order', () => {
    @blob('zebra')
    @role('authenticated', '*')
    class Zebra {}

    @blob('alpha')
    @role('authenticated', '*')
    class Alpha {}

    @blob('mango')
    @role('authenticated', '*')
    class Mango {}

    // Intentionally unsorted input order.
    const analyzer = new SchemaAnalyzer(
      [Zebra, Mango, Alpha],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    const config = new StorageConfigGenerator().generateConfig(folders);

    expect(config.folders.map((f) => f.name)).toEqual([
      'alpha',
      'mango',
      'zebra',
    ]);
  });

  it('walks into combinator branches to catch unknown fields nested inside and/or', () => {
    @blob({ name: 'nested-unknown' })
    @role('authenticated', 'read', {
      policy: (claims, item) =>
        claims.sub
          .eq(item.owner_id)
          .and(claims.role.eq('admin').or(item.mystery.eq('x'))),
    })
    class NestedUnknown {
      declare owner_id: string;
      declare mystery: string;
    }

    const analyzer = new SchemaAnalyzer([NestedUnknown], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /references unknown field 'item\.mystery'/
    );
  });
});

describe('StorageConfigGenerator - rule 3 (folder name collisions)', () => {
  it('throws when two @blob classes normalize to the same folder name', () => {
    @blob('shared-name')
    @role('authenticated', 'read')
    class FirstClass {}

    @blob('shared-name')
    @role('authenticated', 'read')
    class SecondClass {}

    const analyzer = new SchemaAnalyzer(
      [FirstClass, SecondClass],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /folder name collision: 'shared-name'/
    );
  });

  it('throws when the implicit (lowercased) folder name collides with an explicit one', () => {
    @blob()
    @role('authenticated', 'read')
    class Avatars {}

    @blob('avatars')
    @role('authenticated', 'read')
    class AvatarsExplicit {}

    const analyzer = new SchemaAnalyzer(
      [Avatars, AvatarsExplicit],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /folder name collision: 'avatars'/
    );
  });

  it('accepts two distinct folder names that share a prefix', () => {
    @blob('photos')
    @role('authenticated', 'read')
    class Photos {}

    @blob('photos-archive')
    @role('authenticated', 'read')
    class PhotosArchive {}

    const analyzer = new SchemaAnalyzer(
      [Photos, PhotosArchive],
      DatabaseDialect.MsSql
    );
    const folders = analyzer.analyzeStorageFolders();
    expect(() =>
      new StorageConfigGenerator().generateConfig(folders)
    ).not.toThrow();
  });
});

describe('StorageConfigGenerator - rule 5 (no subquery primitives)', () => {
  it('surfaces a guidance message when an unsupported expression reaches the AST serializer', () => {
    // No subquery primitives exist in the policy DSL today (rule 5
    // defers them to a future extension). The AST serializer is the last
    // line of defense: anything that isn't ComparisonExpression or
    // LogicalExpression must throw with a message that points at rule 5.
    @blob({ name: 'bad-expression' })
    @role('authenticated', 'read', {
      // Cast a plain string through the policy callback signature to
      // simulate a future / unsupported expression node reaching the
      // serializer. The point of the test is the error message, not the
      // shape of the bogus value.
      policy: () =>
        'subquery-stub' as unknown as ReturnType<
          Parameters<typeof role>[2] extends { policy?: infer P }
            ? Extract<P, (...args: never) => unknown>
            : never
        >,
    })
    class BadExpression {}

    // The throw happens inside SchemaAnalyzer.aggregatePermissions when the
    // analyzer serializes the policy expression to the JSON DSL — well
    // before generateConfig() gets a chance to run. Wrap both so the test
    // catches the failure regardless of which layer fires first.
    expect(() => {
      const analyzer = new SchemaAnalyzer(
        [BadExpression],
        DatabaseDialect.MsSql
      );
      const folders = analyzer.analyzeStorageFolders();
      new StorageConfigGenerator().generateConfig(folders);
    }).toThrow(/deferred to a future DSL extension/);
  });
});

describe('StorageConfigGenerator - rule 9 (intrinsic field collisions)', () => {
  it('throws when a @blob field collides with a built-in StorageObject field', () => {
    @blob('clashing')
    @role('authenticated', '*')
    class Clashing {
      // `path` is a built-in StorageObjectRef intrinsic; declaring it would
      // silently shadow the server-managed column.
      @text() path!: string;
    }

    const analyzer = new SchemaAnalyzer([Clashing], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /field 'path' conflicts with a built-in StorageObject field/
    );
  });

  it('rejects collisions case-insensitively', () => {
    @blob('clashing-case')
    @role('authenticated', '*')
    class ClashingCase {
      @text() OwnerId!: string; // collides with intrinsic `owner_id`? no — different name
      @text() Size!: string; // collides case-insensitively with intrinsic `size`
    }

    const analyzer = new SchemaAnalyzer([ClashingCase], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() => new StorageConfigGenerator().generateConfig(folders)).toThrow(
      /field 'Size' conflicts with a built-in StorageObject field/
    );
  });

  it('accepts app fields that do not collide with intrinsics', () => {
    @blob('non-clashing')
    @role('authenticated', '*')
    class NonClashing {
      @text() team_id!: string;
      @text() caption!: string;
    }

    const analyzer = new SchemaAnalyzer([NonClashing], DatabaseDialect.MsSql);
    const folders = analyzer.analyzeStorageFolders();
    expect(() =>
      new StorageConfigGenerator().generateConfig(folders)
    ).not.toThrow();
  });
});
