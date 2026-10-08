import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { ConfigGenerator, Config } from '../analysis/dab-config-generator';
import { DatabaseDialect } from '../analysis/dialect-config';
import { SchemaAnalyzer } from '../analysis/schema-analyzer';
import { EntityAnalysisResult } from '../analysis/type-inference';
import { SchemaValidationError } from '../analysis/validation-errors';
import {
  text,
  uuid,
  boolean,
  date,
  set,
  int,
  decimal,
  email,
  one,
  many,
} from '../decorators/decorators.js';
import { entity, role, User } from '../index';

// Suppress console.log during tests
beforeAll(() => {
  console.log = () => {};
});

// GA-rollout gate: this file asserts the new CHECK constraint / COLLATE
// output; enable the flag so the gated code paths run.
let _originalFlags: string | undefined;
beforeAll(() => {
  _originalFlags = process.env.RAYFIN_FEATURE_FLAGS;
  process.env.RAYFIN_FEATURE_FLAGS = 'cli-minor-fixes';
});
afterAll(() => {
  if (_originalFlags === undefined) delete process.env.RAYFIN_FEATURE_FLAGS;
  else process.env.RAYFIN_FEATURE_FLAGS = _originalFlags;
});

// ============================================================================
// BASIC ENTITY TESTS
// ============================================================================

describe('ConfigGenerator - Basic Entity', () => {
  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class Todo {
    @uuid() id!: string;
    @text() title!: string;
    @text({ optional: true }) description?: string;
    @boolean() isCompleted!: boolean;
    @date() createdAt!: Date;
    @date() updatedAt!: Date;
  }

  it('should generate correct config for basic entity (MSSQL)', () => {
    const analyzer = new SchemaAnalyzer([Todo], DatabaseDialect.MsSql);
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    expect(config.$schema).toBe(
      'https://github.com/Azure/data-api-builder/releases/download/v1.5.56/dab.draft.schema.json'
    );
    expect(config.entities.Todo).toEqual({
      source: 'Todos',
      permissions: [
        { role: 'anonymous', actions: ['read'] },
        { role: 'authenticated', actions: ['*'] },
      ],
      'x-schema': {
        fields: {
          id: { dbType: 'UNIQUEIDENTIFIER', nullable: false },
          title: { dbType: 'NVARCHAR(MAX)', nullable: false },
          description: { dbType: 'NVARCHAR(MAX)', nullable: true },
          isCompleted: { dbType: 'BIT', nullable: false },
          createdAt: { dbType: 'DATETIME2', nullable: false },
          updatedAt: { dbType: 'DATETIME2', nullable: false },
        },
        constraints: {
          primaryKey: { name: 'PK_Todos', columns: ['id'] },
        },
      },
    });
  });

  it('should generate correct config for basic entity (PostgreSQL)', () => {
    const analyzer = new SchemaAnalyzer([Todo], DatabaseDialect.PostgreSql);
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.PostgreSql);
    const config = generator.generateConfig(entities);

    expect(config.entities.Todo['x-schema']).toEqual({
      fields: {
        id: { dbType: 'UUID', nullable: false },
        title: { dbType: 'TEXT', nullable: false },
        description: { dbType: 'TEXT', nullable: true },
        isCompleted: { dbType: 'BOOLEAN', nullable: false },
        createdAt: { dbType: 'TIMESTAMP WITH TIME ZONE', nullable: false },
        updatedAt: { dbType: 'TIMESTAMP WITH TIME ZONE', nullable: false },
      },
      constraints: {
        primaryKey: { name: 'PK_Todos', columns: ['id'] },
      },
    });
  });
});

// ============================================================================
// CONSTRAINTS TESTS
// ============================================================================

describe('ConfigGenerator - Constraints', () => {
  @entity()
  @role('authenticated', '*')
  class ProjectTask {
    @uuid() id!: string;
    @text({ unique: true, max: 200 }) slug!: string;
    @text() title!: string;
    @set('pending', 'in-progress', 'completed', 'cancelled') status!:
      | 'pending'
      | 'in-progress'
      | 'completed'
      | 'cancelled';
    @set('low', 'medium', 'high') priority!: 'low' | 'medium' | 'high';
    @date() createdAt!: Date;
  }

  it('should generate primary key, unique, and check constraints (MSSQL)', () => {
    const analyzer = new SchemaAnalyzer([ProjectTask], DatabaseDialect.MsSql);
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    expect(config.entities.ProjectTask).toEqual({
      source: 'ProjectTasks',
      permissions: [{ role: 'authenticated', actions: ['*'] }],
      'x-schema': {
        fields: {
          id: { dbType: 'UNIQUEIDENTIFIER', nullable: false },
          slug: { dbType: 'NVARCHAR(200)', nullable: false },
          title: { dbType: 'NVARCHAR(MAX)', nullable: false },
          status: { dbType: 'NVARCHAR(11)', nullable: false },
          priority: { dbType: 'NVARCHAR(6)', nullable: false },
          createdAt: { dbType: 'DATETIME2', nullable: false },
        },
        constraints: {
          primaryKey: { name: 'PK_ProjectTasks', columns: ['id'] },
          uniqueConstraints: [
            { name: 'UQ_ProjectTasks_slug', columns: ['slug'] },
          ],
          checkConstraints: [
            {
              name: 'CK_ProjectTasks_status',
              expression:
                "[status] COLLATE Latin1_General_100_BIN2 IN ('pending', 'in-progress', 'completed', 'cancelled')",
            },
            {
              name: 'CK_ProjectTasks_priority',
              expression:
                "[priority] COLLATE Latin1_General_100_BIN2 IN ('low', 'medium', 'high')",
            },
          ],
        },
      },
    });
  });

  it('should generate check constraints for PostgreSQL', () => {
    const analyzer = new SchemaAnalyzer(
      [ProjectTask],
      DatabaseDialect.PostgreSql
    );
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.PostgreSql);
    const config = generator.generateConfig(entities);

    expect(
      config.entities.ProjectTask['x-schema']?.constraints.checkConstraints
    ).toEqual([
      {
        name: 'CK_ProjectTasks_status',
        expression:
          "\"status\" IN ('pending', 'in-progress', 'completed', 'cancelled')",
      },
      {
        name: 'CK_ProjectTasks_priority',
        expression: "\"priority\" IN ('low', 'medium', 'high')",
      },
    ]);
  });
});

// ============================================================================
// MIN-LENGTH CONSTRAINT TESTS
// ============================================================================

describe('ConfigGenerator - Min-Length Constraints', () => {
  @entity()
  @role('authenticated', '*')
  class Article {
    @uuid() id!: string;
    @text({ min: 1, max: 200 }) title!: string;
    @text({ min: 10 }) body!: string;
    @text() subtitle!: string; // no min — no constraint
  }

  it('should generate min-length check constraint for MSSQL', () => {
    const analyzer = new SchemaAnalyzer([Article], DatabaseDialect.MsSql);
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    const checkConstraints =
      config.entities.Article['x-schema']?.constraints.checkConstraints;

    expect(checkConstraints).toEqual([
      {
        name: 'CK_Articles_title_minlen',
        expression: 'LEN([title]) >= 1',
      },
      {
        name: 'CK_Articles_body_minlen',
        expression: 'LEN([body]) >= 10',
      },
    ]);
  });

  it('should generate min-length check constraint for PostgreSQL', () => {
    const analyzer = new SchemaAnalyzer([Article], DatabaseDialect.PostgreSql);
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.PostgreSql);
    const config = generator.generateConfig(entities);

    const checkConstraints =
      config.entities.Article['x-schema']?.constraints.checkConstraints;

    expect(checkConstraints).toEqual([
      {
        name: 'CK_Articles_title_minlen',
        expression: 'LENGTH("title") >= 1',
      },
      {
        name: 'CK_Articles_body_minlen',
        expression: 'LENGTH("body") >= 10',
      },
    ]);
  });

  it('should not generate min-length constraint when min is 0', () => {
    @entity()
    @role('authenticated', '*')
    class Note {
      @uuid() id!: string;
      @text({ min: 0, max: 100 }) content!: string;
    }

    const analyzer = new SchemaAnalyzer([Note], DatabaseDialect.MsSql);
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    // No check constraints should exist — min: 0 is a no-op
    expect(
      config.entities.Note['x-schema']?.constraints.checkConstraints
    ).toBeUndefined();
  });
});

// ============================================================================
// NUMERIC RANGE CONSTRAINT TESTS
// ============================================================================

describe('ConfigGenerator - Numeric Range Constraints', () => {
  @entity()
  @role('authenticated', '*')
  class Product {
    @uuid() id!: string;
    @int({ min: 1, max: 100 }) quantity!: number;
    @int({ min: 0 }) views!: number;
    @int({ max: 999 }) score!: number;
    @int() untouched!: number; // no range — no constraint
    @decimal({ min: 0.01, max: 9999.99, precision: 10, scale: 2 })
    price!: number;
    @decimal({ max: 100, precision: 5, scale: 2 }) discount!: number;
  }

  it('should generate numeric range check constraints for MSSQL', () => {
    const analyzer = new SchemaAnalyzer([Product], DatabaseDialect.MsSql);
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    expect(
      config.entities.Product['x-schema']?.constraints.checkConstraints
    ).toEqual([
      {
        name: 'CK_Products_quantity_range',
        expression: '[quantity] >= 1 AND [quantity] <= 100',
      },
      {
        name: 'CK_Products_views_range',
        expression: '[views] >= 0',
      },
      {
        name: 'CK_Products_score_range',
        expression: '[score] <= 999',
      },
      {
        name: 'CK_Products_price_range',
        expression: '[price] >= 0.01 AND [price] <= 9999.99',
      },
      {
        name: 'CK_Products_discount_range',
        expression: '[discount] <= 100',
      },
    ]);
  });

  it('should generate numeric range check constraints for PostgreSQL', () => {
    const analyzer = new SchemaAnalyzer([Product], DatabaseDialect.PostgreSql);
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.PostgreSql);
    const config = generator.generateConfig(entities);

    expect(
      config.entities.Product['x-schema']?.constraints.checkConstraints
    ).toEqual([
      {
        name: 'CK_Products_quantity_range',
        expression: '"quantity" >= 1 AND "quantity" <= 100',
      },
      {
        name: 'CK_Products_views_range',
        expression: '"views" >= 0',
      },
      {
        name: 'CK_Products_score_range',
        expression: '"score" <= 999',
      },
      {
        name: 'CK_Products_price_range',
        expression: '"price" >= 0.01 AND "price" <= 9999.99',
      },
      {
        name: 'CK_Products_discount_range',
        expression: '"discount" <= 100',
      },
    ]);
  });
});

// ============================================================================
// ADVANCED PERMISSIONS TESTS
// ============================================================================

describe('ConfigGenerator - Advanced Permissions', () => {
  @entity()
  @role('anonymous', 'read')
  @role('authenticated', 'create', {
    policy: (claims, item) => claims.sub.eq(item.createdBy),
    include: ['createdByDisplay'],
  })
  @role('authenticated', 'read', {
    policy: (claims, item) => claims.sub.eq(item.createdBy),
  })
  @role('authenticated', 'update', {
    policy: (claims, item) => claims.sub.eq(item.createdBy),
    exclude: ['adminContent'],
  })
  @role('authenticated', '*')
  class SecureDocument {
    @uuid() id!: string;
    @text() title!: string;
    @text() content!: string;
    @text({ optional: true })
    adminContent?: string;
    @text() createdBy!: string;
    @text()
    createdByDisplay?: string;
    @date() createdAt!: Date;
  }

  it('should generate complex permission objects', () => {
    const analyzer = new SchemaAnalyzer(
      [SecureDocument],
      DatabaseDialect.MsSql
    );
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    expect(config.entities.SecureDocument.permissions).toEqual([
      { role: 'anonymous', actions: ['read'] },
      {
        role: 'authenticated',
        actions: [
          '*',
          {
            action: 'update',
            fields: { include: ['*'], exclude: ['adminContent'] },
            policy: { database: '@claims.sub eq @item.createdBy' },
          },
          {
            action: 'read',
            policy: { database: '@claims.sub eq @item.createdBy' },
          },
          {
            action: 'create',
            fields: { include: ['createdByDisplay'] },
            policy: { database: '@claims.sub eq @item.createdBy' },
          },
        ],
      },
    ]);
  });
});

// ============================================================================
// RELATIONSHIP TESTS - BIDIRECTIONAL (@one + @many)
// ============================================================================

describe('ConfigGenerator - Bidirectional Relationships', () => {
  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class Author {
    @uuid() id!: string;
    @text() name!: string;
    @many(() => Book) books!: Book[];
  }

  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class Book {
    @uuid() id!: string;
    @text() title!: string;
    @text({ optional: true }) synopsis?: string;
    @date() publishedOn!: Date;
    @one(() => Author) author!: Author;
  }

  it('should generate correct relationships for bidirectional @one/@many', () => {
    const analyzer = new SchemaAnalyzer([Author, Book], DatabaseDialect.MsSql);
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    // Book should have FK to Author
    expect(config.entities.Book).toEqual({
      source: 'Books',
      permissions: [
        { role: 'anonymous', actions: ['read'] },
        { role: 'authenticated', actions: ['*'] },
      ],
      'x-schema': {
        fields: {
          id: { dbType: 'UNIQUEIDENTIFIER', nullable: false },
          title: { dbType: 'NVARCHAR(MAX)', nullable: false },
          synopsis: { dbType: 'NVARCHAR(MAX)', nullable: true },
          publishedOn: { dbType: 'DATETIME2', nullable: false },
          author_id: { dbType: 'UNIQUEIDENTIFIER', nullable: false },
        },
        constraints: {
          primaryKey: { name: 'PK_Books', columns: ['id'] },
          foreignKeys: [
            {
              name: 'FK_Books_author_id',
              columns: ['author_id'],
              referencedTable: 'Authors',
              referencedColumns: ['id'],
            },
          ],
        },
      },
      relationships: {
        author: {
          cardinality: 'one',
          'target.entity': 'Author',
          'source.fields': ['author_id'],
          'target.fields': ['id'],
        },
      },
    });

    // Author should have @many relationship to Books
    expect(config.entities.Author.relationships).toEqual({
      books: {
        cardinality: 'many',
        'target.entity': 'Book',
        'source.fields': ['id'],
        'target.fields': ['author_id'],
      },
    });
  });
});

// ============================================================================
// RELATIONSHIP TESTS - UNIDIRECTIONAL @many ONLY
// ============================================================================

describe('ConfigGenerator - Unidirectional @many Relationships', () => {
  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class CategoryUni {
    @uuid() id!: string;
    @text() name!: string;
    @text({ optional: true }) description?: string;
    @text({ optional: true }) color?: string;
    @many(() => TodoUni) todos!: TodoUni[];
  }

  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class TodoUni {
    @uuid() id!: string;
    @text() title!: string;
    @text({ optional: true }) description?: string;
    @boolean() isCompleted!: boolean;
    @set('low', 'medium', 'high') priority!: 'low' | 'medium' | 'high';
    @date({ optional: true }) dueDate?: Date;
    @date() createdAt!: Date;
    @date() updatedAt!: Date;
  }

  it('should infer FK on target entity for unidirectional @many', () => {
    const analyzer = new SchemaAnalyzer(
      [CategoryUni, TodoUni],
      DatabaseDialect.MsSql
    );
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    // TodoUni should have inferred FK column Category_id
    expect(
      config.entities.TodoUni['x-schema']?.fields['CategoryUni_id']
    ).toEqual({
      dbType: 'UNIQUEIDENTIFIER',
      nullable: false,
    });

    expect(
      config.entities.TodoUni['x-schema']?.constraints.foreignKeys
    ).toContainEqual({
      name: 'FK_TodoUnis_CategoryUni_id',
      columns: ['CategoryUni_id'],
      referencedTable: 'CategoryUnis',
      referencedColumns: ['id'],
    });

    // Category should have relationship pointing to TodoUni
    expect(config.entities.CategoryUni.relationships).toEqual({
      todos: {
        cardinality: 'many',
        'target.entity': 'TodoUni',
        'source.fields': ['id'],
        'target.fields': ['CategoryUni_id'],
      },
    });
  });
});

// ============================================================================
// RELATIONSHIP TESTS - OPTIONAL RELATIONSHIPS
// ============================================================================

describe('ConfigGenerator - Optional Relationships', () => {
  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class CategoryOpt {
    @uuid() id!: string;
    @text() name!: string;
    @text({ optional: true }) description?: string;
    @text({ optional: true }) color?: string;
  }

  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class TodoOpt {
    @uuid() id!: string;
    @text() title!: string;
    @text({ optional: true }) description?: string;
    @boolean() isCompleted!: boolean;
    @set('low', 'medium', 'high') priority!: 'low' | 'medium' | 'high';
    @date({ optional: true }) dueDate?: Date;
    @date() createdAt!: Date;
    @date() updatedAt!: Date;
    @one(() => CategoryOpt, { optional: true }) category?: CategoryOpt;
    @one(() => User) user!: User;
  }

  it('should generate nullable FK for optional relationship', () => {
    const analyzer = new SchemaAnalyzer(
      [CategoryOpt, TodoOpt],
      DatabaseDialect.MsSql
    );
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    // Optional category FK should be nullable
    expect(config.entities.TodoOpt['x-schema']?.fields['category_id']).toEqual({
      dbType: 'UNIQUEIDENTIFIER',
      nullable: true,
    });

    // Required user FK should not be nullable
    expect(config.entities.TodoOpt['x-schema']?.fields['user_id']).toEqual({
      dbType: 'UNIQUEIDENTIFIER',
      nullable: false,
    });

    expect(config.entities.TodoOpt.relationships).toEqual({
      category: {
        cardinality: 'one',
        'target.entity': 'CategoryOpt',
        'source.fields': ['category_id'],
        'target.fields': ['id'],
      },
      user: {
        cardinality: 'one',
        'target.entity': 'User',
        'source.fields': ['user_id'],
        'target.fields': ['Id'],
      },
    });
  });

  it('preserves nullability from an explicitly declared FK field', () => {
    const originalFlags = process.env.RAYFIN_FEATURE_FLAGS;
    process.env.RAYFIN_FEATURE_FLAGS = 'cli-minor-fixes';

    try {
      @entity()
      @role('authenticated', '*')
      class CustomerSegment {
        @uuid() id!: string;
      }

      @entity()
      @role('authenticated', '*')
      class Customer {
        @uuid() id!: string;
        @uuid({ optional: true }) customerSegment_id?: string;
        @one(() => CustomerSegment) customerSegment?: CustomerSegment;
      }

      const entities = new SchemaAnalyzer(
        [CustomerSegment, Customer],
        DatabaseDialect.MsSql
      ).analyzeEntities();
      const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
        entities
      );

      expect(
        config.entities.Customer['x-schema']?.fields.customerSegment_id
      ).toEqual({
        dbType: 'UNIQUEIDENTIFIER',
        nullable: true,
      });
      expect(
        config.entities.Customer['x-schema']?.constraints.foreignKeys
      ).toContainEqual({
        name: 'FK_Customers_customerSegment_id',
        columns: ['customerSegment_id'],
        referencedTable: 'CustomerSegments',
        referencedColumns: ['id'],
      });
    } finally {
      if (originalFlags === undefined) {
        delete process.env.RAYFIN_FEATURE_FLAGS;
      } else {
        process.env.RAYFIN_FEATURE_FLAGS = originalFlags;
      }
    }
  });

  it('overwrites an explicitly declared FK field when cli-minor-fixes is off', () => {
    const originalFlags = process.env.RAYFIN_FEATURE_FLAGS;
    delete process.env.RAYFIN_FEATURE_FLAGS;

    try {
      @entity()
      @role('authenticated', '*')
      class CustomerSegment {
        @uuid() id!: string;
      }

      @entity()
      @role('authenticated', '*')
      class Customer {
        @uuid() id!: string;
        @uuid({ optional: true }) customerSegment_id?: string;
        @one(() => CustomerSegment) customerSegment?: CustomerSegment;
      }

      const entities = new SchemaAnalyzer(
        [CustomerSegment, Customer],
        DatabaseDialect.MsSql
      ).analyzeEntities();
      const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
        entities
      );

      // Legacy behavior: relationship-derived column overwrites the explicit
      // FK, so `nullable: true` from the @uuid({ optional: true }) declaration
      // is lost. The flag-on test above proves the fix restores it.
      expect(
        config.entities.Customer['x-schema']?.fields.customerSegment_id
          ?.nullable
      ).toBe(false);
    } finally {
      if (originalFlags !== undefined) {
        process.env.RAYFIN_FEATURE_FLAGS = originalFlags;
      }
    }
  });
});

// ============================================================================
// RELATIONSHIP TESTS - MULTIPLE FKs TO SAME ENTITY (PERMUTATIONS)
// ============================================================================

describe('ConfigGenerator - Multiple FKs to Same Entity', () => {
  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class Account {
    @uuid() id!: string;
    @text() displayName!: string;
    @set('standard', 'premium') plan!: 'standard' | 'premium';
  }

  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class AccountSubscription {
    @uuid() id!: string;
    @date() startedOn!: Date;
    @one(() => Account) subscriber!: Account;
    @one(() => Account) publisher!: Account;
  }

  it('should generate distinct FK columns for multiple relationships to same entity', () => {
    const analyzer = new SchemaAnalyzer(
      [Account, AccountSubscription],
      DatabaseDialect.MsSql
    );
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    expect(config.entities.AccountSubscription['x-schema']?.fields).toEqual({
      id: { dbType: 'UNIQUEIDENTIFIER', nullable: false },
      startedOn: { dbType: 'DATETIME2', nullable: false },
      subscriber_id: { dbType: 'UNIQUEIDENTIFIER', nullable: false },
      publisher_id: { dbType: 'UNIQUEIDENTIFIER', nullable: false },
    });

    expect(
      config.entities.AccountSubscription['x-schema']?.constraints.foreignKeys
    ).toEqual([
      {
        name: 'FK_AccountSubscriptions_subscriber_id',
        columns: ['subscriber_id'],
        referencedTable: 'Accounts',
        referencedColumns: ['id'],
      },
      {
        name: 'FK_AccountSubscriptions_publisher_id',
        columns: ['publisher_id'],
        referencedTable: 'Accounts',
        referencedColumns: ['id'],
      },
    ]);

    expect(config.entities.AccountSubscription.relationships).toEqual({
      subscriber: {
        cardinality: 'one',
        'target.entity': 'Account',
        'source.fields': ['subscriber_id'],
        'target.fields': ['id'],
      },
      publisher: {
        cardinality: 'one',
        'target.entity': 'Account',
        'source.fields': ['publisher_id'],
        'target.fields': ['id'],
      },
    });
  });
});

// ============================================================================
// RELATIONSHIP TESTS - WITH SYSTEM USER ENTITY
// ============================================================================

describe('ConfigGenerator - System User Entity', () => {
  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class CategoryWithUser {
    @uuid() id!: string;
    @text() name!: string;
    @text({ optional: true }) description?: string;
    @text({ optional: true }) color?: string;
  }

  @entity()
  @role('anonymous', 'read')
  @role('authenticated', '*')
  class TodoWithUser {
    @uuid() id!: string;
    @text() title!: string;
    @text({ optional: true }) description?: string;
    @boolean() isCompleted!: boolean;
    @set('low', 'medium', 'high') priority!: 'low' | 'medium' | 'high';
    @date({ optional: true }) dueDate?: Date;
    @date() createdAt!: Date;
    @date() updatedAt!: Date;
    @one(() => CategoryWithUser) category!: CategoryWithUser;
    @one(() => User) user!: User;
  }

  it('should reference User entity with proper casing (Id)', () => {
    const analyzer = new SchemaAnalyzer(
      [CategoryWithUser, TodoWithUser],
      DatabaseDialect.MsSql
    );
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    // User entity should be excluded from config (system entity)
    expect(config.entities.User).toBeUndefined();

    // User FK should reference Users.Id (capital I)
    const userFk = config.entities.TodoWithUser[
      'x-schema'
    ]?.constraints.foreignKeys?.find((fk) => fk.columns[0] === 'user_id');

    expect(userFk).toEqual({
      name: 'FK_TodoWithUsers_user_id',
      columns: ['user_id'],
      referencedTable: 'Users',
      referencedColumns: ['Id'],
    });

    expect(config.entities.TodoWithUser.relationships?.user).toEqual({
      cardinality: 'one',
      'target.entity': 'User',
      'source.fields': ['user_id'],
      'target.fields': ['Id'],
    });
  });
});

// ============================================================================
// ERROR CASE TESTS
// ============================================================================

describe('ConfigGenerator - Error Cases', () => {
  it('should throw error for bidirectional one-to-one relationships', () => {
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);

    const entities: EntityAnalysisResult[] = [
      {
        name: 'Book',
        tableName: 'Books',
        permissions: {},
        fields: [
          {
            name: 'id',
            originalName: 'id',
            dbType: 'UNIQUEIDENTIFIER',
            nullable: false,
            primaryKey: true,
            unique: true,
            isRelationship: false,
          },
          {
            name: 'details',
            originalName: 'details',
            dbType: 'RELATIONSHIP_SINGLE',
            nullable: false,
            primaryKey: false,
            unique: false,
            isRelationship: true,
            relationshipType: 'many-to-one',
            foreignKey: {
              referencedEntity: 'BookDetail',
              referencedField: 'id',
            },
            generatedForeignKeyColumn: 'details_id',
          },
        ],
      },
      {
        name: 'BookDetail',
        tableName: 'BookDetails',
        permissions: {},
        fields: [
          {
            name: 'id',
            originalName: 'id',
            dbType: 'UNIQUEIDENTIFIER',
            nullable: false,
            primaryKey: true,
            unique: true,
            isRelationship: false,
          },
          {
            name: 'book',
            originalName: 'book',
            dbType: 'RELATIONSHIP_SINGLE',
            nullable: false,
            primaryKey: false,
            unique: false,
            isRelationship: true,
            relationshipType: 'many-to-one',
            foreignKey: {
              referencedEntity: 'Book',
              referencedField: 'id',
            },
            generatedForeignKeyColumn: 'book_id',
          },
        ],
      },
    ];

    expect(() => generator.generateConfig(entities)).toThrow(
      'One-to-one relationship detected between Book and BookDetail. This is not currently supported.'
    );
  });

  it('should throw error for many-to-many relationships', () => {
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);

    const entities: EntityAnalysisResult[] = [
      {
        name: 'Author',
        tableName: 'Authors',
        permissions: {},
        fields: [
          {
            name: 'id',
            originalName: 'id',
            dbType: 'UNIQUEIDENTIFIER',
            nullable: false,
            primaryKey: true,
            unique: true,
            isRelationship: false,
          },
          {
            name: 'books',
            originalName: 'books',
            dbType: 'RELATIONSHIP_ARRAY',
            nullable: false,
            primaryKey: false,
            unique: false,
            isRelationship: true,
            relationshipType: 'one-to-many',
            foreignKey: {
              referencedEntity: 'Book',
              referencedField: 'id',
            },
          },
        ],
      },
      {
        name: 'Book',
        tableName: 'Books',
        permissions: {},
        fields: [
          {
            name: 'id',
            originalName: 'id',
            dbType: 'UNIQUEIDENTIFIER',
            nullable: false,
            primaryKey: true,
            unique: true,
            isRelationship: false,
          },
          {
            name: 'authors',
            originalName: 'authors',
            dbType: 'RELATIONSHIP_ARRAY',
            nullable: false,
            primaryKey: false,
            unique: false,
            isRelationship: true,
            relationshipType: 'one-to-many',
            foreignKey: {
              referencedEntity: 'Author',
              referencedField: 'id',
            },
          },
        ],
      },
    ];

    expect(() => generator.generateConfig(entities)).toThrow(
      'Many-to-many relationship detected between Author and Book. This is not currently supported.'
    );
  });

  it('should throw error for ambiguous @many relationships', () => {
    @entity()
    @role('anonymous', 'read')
    @role('authenticated', '*')
    class Principal {
      @uuid() id!: string;
      @text() title!: string;
      @many(() => Dependent) writtenDependents!: Dependent[];
      @many(() => Dependent) reviewedDependents!: Dependent[];
    }

    @entity()
    @role('anonymous', 'read')
    @role('authenticated', '*')
    class Dependent {
      @uuid() id!: string;
      @text() name!: string;
    }

    const analyzer = new SchemaAnalyzer(
      [Principal, Dependent],
      DatabaseDialect.MsSql
    );
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);

    expect(() => generator.generateConfig(entities)).toThrow(
      /Ambiguous relationship detected: Entity 'Principal' has multiple @many relationships to 'Dependent'/
    );
  });
});

// ============================================================================
// DEFAULT PERMISSIONS TESTS
// ============================================================================

describe('ConfigGenerator - Default Permissions', () => {
  @entity()
  class EntityWithNoPermissions {
    @uuid() id!: string;
    @text() name!: string;
  }

  it('should apply default authenticated permissions when none specified', () => {
    const analyzer = new SchemaAnalyzer(
      [EntityWithNoPermissions],
      DatabaseDialect.MsSql
    );
    const entities = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig(entities);

    expect(config.entities.EntityWithNoPermissions.permissions).toEqual([
      { role: 'authenticated', actions: ['*'] },
    ]);
  });
});

// ============================================================================
// PARAMETERIZED FIELD TYPE TESTS
// ============================================================================

describe('ConfigGenerator - All Field Types', () => {
  @entity()
  @role('authenticated', '*')
  class AllFieldTypes {
    @uuid() id!: string;
    @text() textField!: string;
    @email() emailField!: string;
    @int() intField!: number;
    @decimal() decimalField!: number;
    @boolean() boolField!: boolean;
    @date() dateField!: Date;
  }

  const mssqlEntities = new SchemaAnalyzer(
    [AllFieldTypes],
    DatabaseDialect.MsSql
  ).analyzeEntities();
  const mssqlConfig = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
    mssqlEntities
  );

  const pgEntities = new SchemaAnalyzer(
    [AllFieldTypes],
    DatabaseDialect.PostgreSql
  ).analyzeEntities();
  const pgConfig = new ConfigGenerator(
    DatabaseDialect.PostgreSql
  ).generateConfig(pgEntities);

  it.each([
    ['id', 'UNIQUEIDENTIFIER', 'UUID'],
    ['textField', 'NVARCHAR(MAX)', 'TEXT'],
    ['emailField', 'NVARCHAR(320)', 'VARCHAR(320)'],
    ['intField', 'INT', 'INTEGER'],
    ['decimalField', 'DECIMAL(18,2)', 'NUMERIC(18,2)'],
    ['boolField', 'BIT', 'BOOLEAN'],
    ['dateField', 'DATETIME2', 'TIMESTAMP WITH TIME ZONE'],
  ])(
    'field %s maps to MSSQL:%s and PG:%s with nullable=false',
    (fieldName, mssqlType, pgType) => {
      const mssqlField =
        mssqlConfig.entities.AllFieldTypes['x-schema']?.fields[fieldName];
      expect(mssqlField).toEqual({ dbType: mssqlType, nullable: false });

      const pgField =
        pgConfig.entities.AllFieldTypes['x-schema']?.fields[fieldName];
      expect(pgField).toEqual({ dbType: pgType, nullable: false });
    }
  );
});

// ============================================================================
// PARAMETERIZED FIELD OPTIONS TESTS
// ============================================================================

describe('ConfigGenerator - All Field Options', () => {
  @entity()
  @role('authenticated', '*')
  class AllFieldOptions {
    @uuid() id!: string;

    // text options
    @text() requiredText!: string;
    @text({ optional: true }) optionalText?: string;
    @text({ unique: true, max: 255 }) uniqueText!: string;
    @text({ max: 100 }) maxLengthText!: string;
    @text({ optional: true, unique: true, max: 255 })
    optionalUniqueText?: string;

    // int options
    @int() requiredInt!: number;
    @int({ optional: true }) optionalInt?: number;
    @int({ unique: true }) uniqueInt!: number;

    // decimal options
    @decimal() requiredDecimal!: number;
    @decimal({ optional: true }) optionalDecimal?: number;

    // boolean options
    @boolean() requiredBool!: boolean;
    @boolean({ optional: true }) optionalBool?: boolean;

    // date options
    @date() requiredDate!: Date;
    @date({ optional: true }) optionalDate?: Date;

    // uuid options
    @uuid({ optional: true }) optionalUuid?: string;

    // email options
    @email() requiredEmail!: string;
    @email({ optional: true }) optionalEmail?: string;
    @email({ unique: true, max: 320 }) uniqueEmail!: string;
  }

  const entities = new SchemaAnalyzer(
    [AllFieldOptions],
    DatabaseDialect.MsSql
  ).analyzeEntities();
  const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
    entities
  );
  const fields = config.entities.AllFieldOptions['x-schema']?.fields;
  const constraints = config.entities.AllFieldOptions['x-schema']?.constraints;

  it.each([
    // [fieldName, expectedDbType, expectedNullable]
    ['requiredText', 'NVARCHAR(MAX)', false],
    ['optionalText', 'NVARCHAR(MAX)', true],
    ['uniqueText', 'NVARCHAR(255)', false],
    ['maxLengthText', 'NVARCHAR(100)', false],
    ['optionalUniqueText', 'NVARCHAR(255)', true],
    ['requiredInt', 'INT', false],
    ['optionalInt', 'INT', true],
    ['uniqueInt', 'INT', false],
    ['requiredDecimal', 'DECIMAL(18,2)', false],
    ['optionalDecimal', 'DECIMAL(18,2)', true],
    ['requiredBool', 'BIT', false],
    ['optionalBool', 'BIT', true],
    ['requiredDate', 'DATETIME2', false],
    ['optionalDate', 'DATETIME2', true],
    ['optionalUuid', 'UNIQUEIDENTIFIER', true],
    ['requiredEmail', 'NVARCHAR(320)', false],
    ['optionalEmail', 'NVARCHAR(320)', true],
    ['uniqueEmail', 'NVARCHAR(320)', false],
  ])(
    'field %s has dbType=%s and nullable=%s',
    (fieldName, expectedDbType, expectedNullable) => {
      expect(fields?.[fieldName]).toEqual({
        dbType: expectedDbType,
        nullable: expectedNullable,
      });
    }
  );

  it.each([
    ['uniqueText', 'UQ_AllFieldOptions_uniqueText'],
    ['optionalUniqueText', 'UQ_AllFieldOptions_optionalUniqueText'],
    ['uniqueInt', 'UQ_AllFieldOptions_uniqueInt'],
    ['uniqueEmail', 'UQ_AllFieldOptions_uniqueEmail'],
  ])('field %s generates unique constraint %s', (fieldName, constraintName) => {
    expect(constraints?.uniqueConstraints).toContainEqual({
      name: constraintName,
      columns: [fieldName],
    });
  });

  it('non-unique fields do not appear in unique constraints', () => {
    const uniqueColumns =
      constraints?.uniqueConstraints?.flatMap((uc) => uc.columns) ?? [];
    expect(uniqueColumns).not.toContain('requiredText');
    expect(uniqueColumns).not.toContain('optionalText');
    expect(uniqueColumns).not.toContain('requiredInt');
    expect(uniqueColumns).not.toContain('optionalInt');
    expect(uniqueColumns).not.toContain('requiredBool');
    expect(uniqueColumns).not.toContain('optionalBool');
    expect(uniqueColumns).not.toContain('requiredDate');
    expect(uniqueColumns).not.toContain('optionalDate');
  });
});

// ============================================================================
// DECIMAL PRECISION/SCALE TESTS
// ============================================================================

describe('ConfigGenerator - Decimal Precision and Scale', () => {
  @entity()
  @role('authenticated', '*')
  class DecimalPrecisionEntity {
    @uuid() id!: string;

    @decimal() defaultDecimal!: number;
    @decimal({ precision: 10, scale: 4 }) customDecimal!: number;
    @decimal({ precision: 5, scale: 0 }) integerLikeDecimal!: number;
    @decimal({ precision: 1, scale: 1 }) minPrecisionDecimal!: number;
  }

  it('should use default precision(18) and scale(2) when not specified (MSSQL)', () => {
    const entities = new SchemaAnalyzer(
      [DecimalPrecisionEntity],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );
    const fields = config.entities.DecimalPrecisionEntity['x-schema']?.fields;

    expect(fields?.defaultDecimal).toEqual({
      dbType: 'DECIMAL(18,2)',
      nullable: false,
    });
  });

  it('should use default NUMERIC(18,2) when not specified (PostgreSQL)', () => {
    const entities = new SchemaAnalyzer(
      [DecimalPrecisionEntity],
      DatabaseDialect.PostgreSql
    ).analyzeEntities();
    const config = new ConfigGenerator(
      DatabaseDialect.PostgreSql
    ).generateConfig(entities);
    const fields = config.entities.DecimalPrecisionEntity['x-schema']?.fields;

    expect(fields?.defaultDecimal).toEqual({
      dbType: 'NUMERIC(18,2)',
      nullable: false,
    });
  });

  it('should use custom precision and scale (MSSQL)', () => {
    const entities = new SchemaAnalyzer(
      [DecimalPrecisionEntity],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );
    const fields = config.entities.DecimalPrecisionEntity['x-schema']?.fields;

    expect(fields?.customDecimal).toEqual({
      dbType: 'DECIMAL(10,4)',
      nullable: false,
    });
  });

  it('should support scale of 0 (MSSQL)', () => {
    const entities = new SchemaAnalyzer(
      [DecimalPrecisionEntity],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );
    const fields = config.entities.DecimalPrecisionEntity['x-schema']?.fields;

    expect(fields?.integerLikeDecimal).toEqual({
      dbType: 'DECIMAL(5,0)',
      nullable: false,
    });
  });

  it('should use custom precision and scale (PostgreSQL)', () => {
    const entities = new SchemaAnalyzer(
      [DecimalPrecisionEntity],
      DatabaseDialect.PostgreSql
    ).analyzeEntities();
    const config = new ConfigGenerator(
      DatabaseDialect.PostgreSql
    ).generateConfig(entities);
    const fields = config.entities.DecimalPrecisionEntity['x-schema']?.fields;

    expect(fields?.customDecimal).toEqual({
      dbType: 'NUMERIC(10,4)',
      nullable: false,
    });
  });

  it.each([
    ['defaultDecimal', 'DECIMAL(18,2)', 'NUMERIC(18,2)'],
    ['customDecimal', 'DECIMAL(10,4)', 'NUMERIC(10,4)'],
    ['integerLikeDecimal', 'DECIMAL(5,0)', 'NUMERIC(5,0)'],
    ['minPrecisionDecimal', 'DECIMAL(1,1)', 'NUMERIC(1,1)'],
  ])('field %s maps to MSSQL:%s and PG:%s', (fieldName, mssqlType, pgType) => {
    const mssqlEntities = new SchemaAnalyzer(
      [DecimalPrecisionEntity],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const mssqlConfig = new ConfigGenerator(
      DatabaseDialect.MsSql
    ).generateConfig(mssqlEntities);

    const pgEntities = new SchemaAnalyzer(
      [DecimalPrecisionEntity],
      DatabaseDialect.PostgreSql
    ).analyzeEntities();
    const pgConfig = new ConfigGenerator(
      DatabaseDialect.PostgreSql
    ).generateConfig(pgEntities);

    expect(
      mssqlConfig.entities.DecimalPrecisionEntity['x-schema']?.fields[fieldName]
    ).toEqual({ dbType: mssqlType, nullable: false });

    expect(
      pgConfig.entities.DecimalPrecisionEntity['x-schema']?.fields[fieldName]
    ).toEqual({ dbType: pgType, nullable: false });
  });
});

// ============================================================================
// E2E: EMAIL BOUNDED LENGTH & UNIQUE CONSTRAINT VALIDATION
// ============================================================================

describe('ConfigGenerator - Email Default Bounded Length', () => {
  @entity()
  @role('authenticated', '*')
  class UserProfile {
    @uuid() id!: string;
    @email() contactEmail!: string;
    @email({ unique: true }) loginEmail!: string;
    @email({ optional: true }) backupEmail?: string;
    @email({ max: 100 }) shortEmail!: string;
  }

  it('should default email to NVARCHAR(320) on MSSQL when no max specified', () => {
    const entities = new SchemaAnalyzer(
      [UserProfile],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );
    const fields = config.entities.UserProfile['x-schema']?.fields;

    expect(fields?.contactEmail).toEqual({
      dbType: 'NVARCHAR(320)',
      nullable: false,
    });
  });

  it('should default email to VARCHAR(320) on PostgreSQL when no max specified', () => {
    const entities = new SchemaAnalyzer(
      [UserProfile],
      DatabaseDialect.PostgreSql
    ).analyzeEntities();
    const config = new ConfigGenerator(
      DatabaseDialect.PostgreSql
    ).generateConfig(entities);
    const fields = config.entities.UserProfile['x-schema']?.fields;

    expect(fields?.contactEmail).toEqual({
      dbType: 'VARCHAR(320)',
      nullable: false,
    });
  });

  it('should respect explicit max on email field', () => {
    const entities = new SchemaAnalyzer(
      [UserProfile],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );
    const fields = config.entities.UserProfile['x-schema']?.fields;

    expect(fields?.shortEmail).toEqual({
      dbType: 'NVARCHAR(100)',
      nullable: false,
    });
  });

  it('should generate unique constraint for email with default bounded length', () => {
    const entities = new SchemaAnalyzer(
      [UserProfile],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );
    const constraints = config.entities.UserProfile['x-schema']?.constraints;

    expect(constraints?.uniqueConstraints).toContainEqual({
      name: 'UQ_UserProfiles_loginEmail',
      columns: ['loginEmail'],
    });
  });

  it('should generate email format check constraints for MSSQL', () => {
    const entities = new SchemaAnalyzer(
      [UserProfile],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );
    const constraints =
      config.entities.UserProfile['x-schema']?.constraints.checkConstraints;

    expect(constraints).toContainEqual({
      name: 'CK_UserProfiles_contactEmail_email',
      expression:
        "[contactEmail] LIKE '_%@_%._%' AND CHARINDEX(' ', [contactEmail]) = 0",
    });
    expect(constraints).toContainEqual({
      name: 'CK_UserProfiles_loginEmail_email',
      expression:
        "[loginEmail] LIKE '_%@_%._%' AND CHARINDEX(' ', [loginEmail]) = 0",
    });
  });

  it('should generate email format check constraints for PostgreSQL', () => {
    const entities = new SchemaAnalyzer(
      [UserProfile],
      DatabaseDialect.PostgreSql
    ).analyzeEntities();
    const config = new ConfigGenerator(
      DatabaseDialect.PostgreSql
    ).generateConfig(entities);
    const constraints =
      config.entities.UserProfile['x-schema']?.constraints.checkConstraints;

    expect(constraints).toContainEqual({
      name: 'CK_UserProfiles_contactEmail_email',
      expression:
        '"contactEmail" LIKE \'_%@_%._%\' AND POSITION(\' \' IN "contactEmail") = 0',
    });
    expect(constraints).toContainEqual({
      name: 'CK_UserProfiles_loginEmail_email',
      expression:
        '"loginEmail" LIKE \'_%@_%._%\' AND POSITION(\' \' IN "loginEmail") = 0',
    });
  });
});

describe('ConfigGenerator - Unique Constraint on Unbounded Text (MSSQL)', () => {
  it('should fail config generation when @text({ unique: true }) has no max on MSSQL', () => {
    @entity()
    @role('authenticated', '*')
    class Article {
      @uuid() id!: string;
      @text({ unique: true }) slug!: string;
    }

    const analyzer = new SchemaAnalyzer([Article], DatabaseDialect.MsSql);

    expect(() => analyzer.analyzeEntities()).toThrow(SchemaValidationError);

    try {
      analyzer.analyzeEntities();
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        const err = error.errors.find(
          (e) => e.field === 'slug' && e.message.includes('MSSQL')
        );
        expect(err).toBeDefined();
        expect(err?.fix).toContain('max');
      }
    }
  });

  it('should succeed when @text({ unique: true }) has no max on PostgreSQL', () => {
    @entity()
    @role('authenticated', '*')
    class Article {
      @uuid() id!: string;
      @text({ unique: true }) slug!: string;
    }

    const analyzer = new SchemaAnalyzer([Article], DatabaseDialect.PostgreSql);
    const entities = analyzer.analyzeEntities();
    const config = new ConfigGenerator(
      DatabaseDialect.PostgreSql
    ).generateConfig(entities);

    expect(config.entities.Article['x-schema']?.fields?.slug).toEqual({
      dbType: 'TEXT',
      nullable: false,
    });
    expect(
      config.entities.Article['x-schema']?.constraints?.uniqueConstraints
    ).toContainEqual({
      name: 'UQ_Articles_slug',
      columns: ['slug'],
    });
  });

  it('should succeed when @text({ unique: true, max: 255 }) on MSSQL', () => {
    @entity()
    @role('authenticated', '*')
    class Article {
      @uuid() id!: string;
      @text({ unique: true, max: 255 }) slug!: string;
    }

    const entities = new SchemaAnalyzer(
      [Article],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );

    expect(config.entities.Article['x-schema']?.fields?.slug).toEqual({
      dbType: 'NVARCHAR(255)',
      nullable: false,
    });
    expect(
      config.entities.Article['x-schema']?.constraints?.uniqueConstraints
    ).toContainEqual({
      name: 'UQ_Articles_slug',
      columns: ['slug'],
    });
  });
});

// ============================================================================
// DEFAULT VALUE TESTS
// ============================================================================

describe('ConfigGenerator - Default Values', () => {
  @entity()
  @role('authenticated', '*')
  class Todo {
    @uuid() id!: string;
    @text({ min: 1, max: 100 }) title!: string;
    @boolean() isCompleted!: boolean;
    @date() createdAt!: Date;
    @date() completedAt!: Date;
    @text() user_id!: string;
    @int({ default: 2 }) priority!: number;
  }

  const entities = new SchemaAnalyzer(
    [Todo],
    DatabaseDialect.MsSql
  ).analyzeEntities();
  const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
    entities
  );
  const fields = config.entities.Todo['x-schema']?.fields;

  it('should include defaultValue for @int({ default: 2 })', () => {
    expect(fields?.priority).toEqual({
      dbType: 'INT',
      nullable: false,
      defaultValue: 2,
    });
  });

  it('should not include defaultValue for fields without a default', () => {
    expect(fields?.title).toEqual({
      dbType: 'NVARCHAR(100)',
      nullable: false,
    });
    expect(fields?.isCompleted).toEqual({
      dbType: 'BIT',
      nullable: false,
    });
  });

  it('should include defaultValue for @boolean({ default: false })', () => {
    @entity()
    @role('authenticated', '*')
    class Settings {
      @uuid() id!: string;
      @boolean({ default: false }) darkMode!: boolean;
    }

    const settingsEntities = new SchemaAnalyzer(
      [Settings],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const settingsConfig = new ConfigGenerator(
      DatabaseDialect.MsSql
    ).generateConfig(settingsEntities);

    expect(
      settingsConfig.entities.Settings['x-schema']?.fields?.darkMode
    ).toEqual({
      dbType: 'BIT',
      nullable: false,
      defaultValue: false,
    });
  });

  it('should include defaultValue for @text({ default: "untitled" })', () => {
    @entity()
    @role('authenticated', '*')
    class Note {
      @uuid() id!: string;
      @text({ default: 'untitled', max: 100 }) title!: string;
    }

    const noteEntities = new SchemaAnalyzer(
      [Note],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const noteConfig = new ConfigGenerator(
      DatabaseDialect.MsSql
    ).generateConfig(noteEntities);

    expect(noteConfig.entities.Note['x-schema']?.fields?.title).toEqual({
      dbType: 'NVARCHAR(100)',
      nullable: false,
      defaultValue: 'untitled',
    });
  });

  it('should include defaultValue for @decimal({ default: 9.99 })', () => {
    @entity()
    @role('authenticated', '*')
    class Product {
      @uuid() id!: string;
      @decimal({ default: 9.99, precision: 10, scale: 2 }) price!: number;
    }

    const productEntities = new SchemaAnalyzer(
      [Product],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const productConfig = new ConfigGenerator(
      DatabaseDialect.MsSql
    ).generateConfig(productEntities);

    expect(productConfig.entities.Product['x-schema']?.fields?.price).toEqual({
      dbType: 'DECIMAL(10,2)',
      nullable: false,
      defaultValue: 9.99,
    });
  });

  it('should include defaultValue for @date({ default: new Date(...) })', () => {
    @entity()
    @role('authenticated', '*')
    class Event {
      @uuid() id!: string;
      @date({ default: new Date('2025-01-01T00:00:00.000Z') }) startDate!: Date;
    }

    const eventEntities = new SchemaAnalyzer(
      [Event],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const eventConfig = new ConfigGenerator(
      DatabaseDialect.MsSql
    ).generateConfig(eventEntities);

    expect(eventConfig.entities.Event['x-schema']?.fields?.startDate).toEqual({
      dbType: 'DATETIME2',
      nullable: false,
      defaultValue: new Date('2025-01-01T00:00:00.000Z'),
    });
  });
});

// ============================================================================
// COLUMN AND GRAPHQL MAPPING TESTS (Section 7 of connector-core-decorators)
// ============================================================================

describe('ConfigGenerator - Column and GraphQL Mapping', () => {
  it('emits no mappings block when @column is not used', () => {
    @entity()
    @role('authenticated', '*')
    class Plain {
      @uuid() id!: string;
      @text() title!: string;
    }

    const entities = new SchemaAnalyzer(
      [Plain],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );

    expect(config.entities.Plain.mappings).toBeUndefined();
    expect(
      Object.keys(config.entities.Plain['x-schema']?.fields ?? {}).sort()
    ).toEqual(['id', 'title']);
  });

  it('uses column rename as the SQL column key and preserves the TS property name in the mappings block when only @column is set', () => {
    @entity()
    @role('authenticated', '*')
    class Renamed {
      @uuid() id!: string;
      @text({ column: 'Display_Name' }) name!: string;
    }

    const entities = new SchemaAnalyzer(
      [Renamed],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );

    expect(
      config.entities.Renamed['x-schema']?.fields?.Display_Name
    ).toBeDefined();
    expect(config.entities.Renamed['x-schema']?.fields?.name).toBeUndefined();
    expect(config.entities.Renamed.mappings).toEqual({
      Display_Name: 'name',
    });
  });

  it('emits column → property-name mapping when @column is set', () => {
    @entity()
    @role('authenticated', '*')
    class Product {
      @uuid() id!: string;
      @int({ column: 'product_category_id' })
      categoryId!: number;
    }

    const entities = new SchemaAnalyzer(
      [Product],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );

    expect(
      config.entities.Product['x-schema']?.fields?.product_category_id
    ).toBeDefined();
    expect(
      config.entities.Product['x-schema']?.fields?.categoryId
    ).toBeUndefined();
    expect(config.entities.Product.mappings).toEqual({
      product_category_id: 'categoryId',
    });
  });

  it('uses the renamed column in PK, unique, and check constraint names and expressions', () => {
    @entity()
    @role('authenticated', '*')
    class Constrained {
      @uuid({ column: 'RowGuid' }) id!: string;
      @text({ unique: true, min: 1, max: 200, column: 'Slug' }) slug!: string;
      @set({ column: 'Priority' }, 'low', 'medium', 'high')
      priority!: 'low' | 'medium' | 'high';
      @int({ column: 'product_category_id', min: 1 }) categoryId!: number;
      @decimal({ column: 'unit_price', min: 0, precision: 10, scale: 2 })
      unitPrice!: number;
    }

    const entities = new SchemaAnalyzer(
      [Constrained],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );

    const constraints =
      config.entities.Constrained['x-schema']?.constraints ?? {};
    expect(constraints.primaryKey?.columns).toEqual(['RowGuid']);
    expect(constraints.uniqueConstraints?.[0]?.columns).toEqual(['Slug']);

    const checks = constraints.checkConstraints ?? [];
    // The min-length CHECK expression must reference the renamed physical
    // column ('Slug'), not the TS property name ('slug') — this is the DDL
    // column-name bug the fix in type-inference.ts addresses.
    const slugCheck = checks.find((c) => c.name.includes('Slug'));
    expect(slugCheck?.expression).toBe('LEN([Slug]) >= 1');
    // The enum CHECK expression must likewise reference the renamed physical
    // column ('Priority'), not the property name ('priority').
    const priorityCheck = checks.find((c) => c.name.includes('Priority'));
    expect(priorityCheck?.expression).toBe(
      "[Priority] COLLATE Latin1_General_100_BIN2 IN ('low', 'medium', 'high')"
    );
    const categoryCheck = checks.find((c) =>
      c.name.includes('product_category_id')
    );
    expect(categoryCheck?.expression).toBe('[product_category_id] >= 1');
    const priceCheck = checks.find((c) => c.name.includes('unit_price'));
    expect(priceCheck?.expression).toBe('[unit_price] >= 0');
  });

  it('escapes the delimiter in mapped column names within CHECK expressions', () => {
    @entity()
    @role('authenticated', '*')
    class Weird {
      @uuid() id!: string;
      // Column names carrying the dialect delimiter must not break the
      // generated CHECK expression — the delimiter has to be doubled.
      @text({ min: 1, max: 50, column: 'we]ird' }) label!: string;
      @set({ column: 'sta"tus' }, 'on', 'off') status!: 'on' | 'off';
    }

    const mssql = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      new SchemaAnalyzer([Weird], DatabaseDialect.MsSql).analyzeEntities()
    );
    const mssqlChecks =
      mssql.entities.Weird['x-schema']?.constraints.checkConstraints ?? [];
    expect(
      mssqlChecks.find((c) => c.expression.startsWith('LEN('))?.expression
    ).toBe('LEN([we]]ird]) >= 1');

    const pg = new ConfigGenerator(DatabaseDialect.PostgreSql).generateConfig(
      new SchemaAnalyzer([Weird], DatabaseDialect.PostgreSql).analyzeEntities()
    );
    const pgChecks =
      pg.entities.Weird['x-schema']?.constraints.checkConstraints ?? [];
    expect(
      pgChecks.find((c) => c.expression.includes(' IN ('))?.expression
    ).toBe('"sta""tus" IN (\'on\', \'off\')');
  });

  it('resolves cross-entity FK referencedColumns to the renamed PK column', () => {
    @entity()
    @role('authenticated', '*')
    class Category {
      @uuid({ column: 'CategoryGuid' }) id!: string;
      @text() name!: string;
    }

    @entity()
    @role('authenticated', '*')
    class Item {
      @uuid() id!: string;
      @text() name!: string;
      @one(() => Category) category?: Category;
    }

    const entities = new SchemaAnalyzer(
      [Category, Item],
      DatabaseDialect.MsSql
    ).analyzeEntities();
    const config = new ConfigGenerator(DatabaseDialect.MsSql).generateConfig(
      entities
    );

    const itemFks =
      config.entities.Item['x-schema']?.constraints?.foreignKeys ?? [];
    expect(itemFks).toHaveLength(1);
    expect(itemFks[0]?.referencedTable).toBe('Categories');
    expect(itemFks[0]?.referencedColumns).toEqual(['CategoryGuid']);
  });
});
