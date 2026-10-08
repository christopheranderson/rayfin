import { describe, it, expect } from 'vitest';

import {
  entity,
  authenticated,
  anonymous,
  role,
  one,
  many,
  text,
  uuid,
  email,
  int,
  decimal,
  boolean,
  date,
  set,
} from '../decorators/decorators';
import { blob } from '../decorators/experimental';
import { claims, createItemProxy, item, PolicyExpression } from '../policy.js';
import { RayfinEntity } from '../schema.js';
import type { EntityMetadata } from '../schema.js';
import { User } from '../system-entities';

function getMeta(cls: unknown): EntityMetadata {
  return (cls as any)[Symbol.metadata]?.[RayfinEntity] as EntityMetadata;
}

describe('Simplified Decorators', () => {
  it('should provide decorators that store runtime metadata', () => {
    // Test that decorators are functions and don't throw when called
    expect(typeof entity).toBe('function');
    expect(typeof role).toBe('function');
    expect(typeof blob).toBe('function');
    expect(typeof one).toBe('function');
    expect(typeof many).toBe('function');
    expect(typeof text).toBe('function');
    expect(typeof uuid).toBe('function');
    expect(typeof email).toBe('function');
    expect(typeof int).toBe('function');
    expect(typeof decimal).toBe('function');
    expect(typeof boolean).toBe('function');
    expect(typeof date).toBe('function');
    expect(typeof set).toBe('function');

    // Test that decorator factories return functions
    expect(typeof entity()).toBe('function');
    expect(typeof role('authenticated', '*')).toBe('function');
    expect(typeof blob()).toBe('function');
    expect(typeof blob('uploads')).toBe('function');
    expect(typeof one(Object.create({}))).toBe('function');
    expect(typeof many(Object.create({}))).toBe('function');
    expect(typeof text()).toBe('function');
    expect(typeof uuid()).toBe('function');
    expect(typeof email()).toBe('function');
    expect(typeof int()).toBe('function');
    expect(typeof decimal()).toBe('function');
    expect(typeof boolean()).toBe('function');
    expect(typeof date()).toBe('function');
    expect(typeof set('option1', 'option2')).toBe('function');
  });

  it('should allow decorators to be applied without runtime errors', () => {
    // This test verifies that the decorators can be applied syntactically
    // The actual metadata verification happens via CLI runtime metadata analysis

    expect(() => {
      @entity()
      @role('authenticated', '*')
      class TestEntity {
        @uuid()
        id!: string;

        @email({ unique: true })
        email!: string;

        @uuid()
        customId!: string;

        @text()
        name!: string;

        @boolean({ optional: true })
        active?: boolean;
      }
    }).not.toThrow();
  });

  it('should support @role with typed policy and field-level include/exclude', () => {
    expect(() => {
      @entity()
      @role('anonymous', 'read')
      @role('authenticated', ['read', 'update'], {
        policy: (c, i) => c.sub.eq(i.owner_id),
      })
      class TestPerms {
        @uuid()
        id!: string;

        @uuid()
        owner_id!: string;

        @text()
        secret?: string;
      }
    }).not.toThrow();
  });

  it('should expose @anonymous and @authenticated shorthands', () => {
    expect(typeof anonymous).toBe('function');
    expect(typeof authenticated).toBe('function');

    // Decorator factories return class decorators
    expect(typeof anonymous()).toBe('function');
    expect(typeof authenticated()).toBe('function');
  });

  it('should attach roles metadata for shorthand decorators', () => {
    @entity()
    @anonymous('read')
    @authenticated('*', {
      policy: (claims, item) => claims.sub.eq(item.id),
      exclude: ['secret'],
    })
    class ShorthandEntity {
      @uuid()
      id!: string;

      @text()
      secret!: string;
    }

    const meta = (ShorthandEntity as any)[Symbol.metadata]?.[
      RayfinEntity
    ] as EntityMetadata;

    expect(meta).toBeDefined();
    expect(meta.roles).toBeDefined();
    expect(meta.roles).toHaveLength(2);
    const roleNames = meta.roles?.map((r) => r.role);
    expect(roleNames).toEqual(
      expect.arrayContaining(['anonymous', 'authenticated'])
    );

    const anon = meta.roles?.find((r) => r.role === 'anonymous');
    const auth = meta.roles?.find((r) => r.role === 'authenticated');

    expect(anon).toMatchObject({ role: 'anonymous', actions: ['read'] });
    expect(auth).toMatchObject({
      role: 'authenticated',
      actions: ['*'],
      excludedFields: ['secret'],
    });
    expect(typeof auth?.policy?.check).toBe('function');
  });

  it('should default shorthand decorators actions to *', () => {
    @entity()
    @anonymous()
    @authenticated()
    class DefaultShorthand {}

    const meta = (DefaultShorthand as any)[Symbol.metadata]?.[
      RayfinEntity
    ] as EntityMetadata;

    const anon = meta.roles?.find((r) => r.role === 'anonymous');
    const auth = meta.roles?.find((r) => r.role === 'authenticated');

    expect(anon?.actions).toEqual(['*']);
    expect(auth?.actions).toEqual(['*']);
  });

  it('should enforce @entity and @blob exclusivity', () => {
    expect(() => {
      @entity()
      @blob()
      class Bad {}
    }).toThrow();
  });

  it('should re-export `anonymous` from the package-root barrel', async () => {
    // The `anonymous` decorator is part of the stable public API and is
    // exported from the package root (`@microsoft/rayfin-core`).
    const root = await import('../index.js');
    expect((root as Record<string, unknown>).anonymous).toBeDefined();

    // Other stable role decorators are also present.
    expect((root as Record<string, unknown>).role).toBeDefined();
    expect((root as Record<string, unknown>).authenticated).toBeDefined();
  });

  it('should expose storage APIs only from the experimental barrel', async () => {
    const stable = (await import('../index.js')) as Record<string, unknown>;
    const experimental = (await import('../experimental/index.js')) as Record<
      string,
      unknown
    >;
    const storageExports = [
      'blob',
      'StorageObject',
      'ContentTypes',
      'bytes',
      'kb',
      'mb',
      'gb',
    ];

    for (const name of storageExports) {
      expect(stable).not.toHaveProperty(name);
      expect(experimental).toHaveProperty(name);
    }
  });

  it('should type-check policy DSL', () => {
    // compile-time assertions
    const itemProxy = createItemProxy<{ user_id: string }>();
    const expr: PolicyExpression = claims.sub.eq(itemProxy.user_id);
    expect(expr.toString()).toBe('@claims.sub eq @item.user_id');
    expect(() => expr.and(claims.role.eq('admin'))).not.toThrow();
    expect(() => claims.email.neq('foo@example.com')).not.toThrow();

    // runtime formatting
    const e2 = claims.role.eq('admin').and(item.user_id.eq('abc'));
    expect(e2.toString()).toBe(
      "(@claims.role eq 'admin') and (@item.user_id eq 'abc')"
    );
  });

  it('should support TypeScript type annotations for inference', () => {
    expect(() => {
      @entity()
      class TypeInferenceTest {
        @uuid()
        id!: string; // Should infer: PK, UNIQUEIDENTIFIER

        @text()
        title!: string;

        @text({ optional: true })
        description?: string; // Should infer: NVARCHAR(MAX), nullable

        @int()
        count!: number; // Should infer: INT

        @boolean()
        active!: boolean; // Should infer: BIT

        @date()
        createdAt!: Date; // Should infer: DATETIME2

        // overload 1
        @set('active', 'inactive')
        status!: 'active' | 'inactive'; // Should infer: NVARCHAR(50) + check constraint

        // overload 2
        @set({ enum: ['small', 'medium', 'large'], optional: true })
        size?: 'small' | 'medium' | 'large'; // Should infer: NVARCHAR(50) + check constraint, nullable

        // overload 3
        @set({ optional: true }, 'red', 'green', 'blue')
        color?: 'red' | 'green' | 'blue'; // Should infer: NVARCHAR(50) + check constraint, nullable
      }
    }).not.toThrow();
  });

  it('should support enum decorator for constrained string values', () => {
    expect(() => {
      @entity()
      class Task {
        @uuid()
        id!: string;

        @text()
        title!: string;

        @set('pending', 'in-progress', 'completed')
        status!: 'pending' | 'in-progress' | 'completed';

        @set({ optional: true }, 'low', 'medium', 'high')
        priority?: 'low' | 'medium' | 'high';
      }
    }).not.toThrow();
  });

  it('should support relationship definitions with runtime metadata', () => {
    expect(() => {
      @entity()
      class Category {
        @uuid()
        id!: string;

        @text()
        name!: string;

        @many(() => Post) // use resolver when we reference a class declared later
        posts!: Post[]; // Should infer: one-to-many
      }

      @entity()
      class Post {
        @uuid()
        id!: string;

        @text()
        title!: string;

        @one(() => Category)
        category!: Category; // Should infer: many-to-one + FK generation

        // Test system entity reference (convention-based)
        @one(() => User)
        createdBy!: User; // Should infer: system entity relationship + FK generation
      }
    }).not.toThrow();
  });

  it('should support storage folder definitions with runtime metadata', () => {
    expect(() => {
      @blob('uploads')
      @role('authenticated', ['create', 'read', 'delete'])
      class FileModel {
        owner_id!: string;
      }
    }).not.toThrow();
    // Test blob decorator without folder name parameter (should use class name)
    expect(() => {
      @blob()
      @role('authenticated', 'read')
      class DocumentStorage {
        owner_id!: string;
      }
    }).not.toThrow();
  });

  it('should support @blob with the options object form', () => {
    @blob({
      name: 'Avatars',
      onConflict: 'overwrite',
    })
    @role('authenticated', ['create', 'read', 'update'])
    class Avatar {
      owner_id!: string;
    }

    const meta = (Avatar as any)[Symbol.metadata]?.[
      Symbol.for('microsoft.rayfin.storage.folder')
    ];
    expect(meta).toBeDefined();
    expect(meta.folderName).toBe('avatars');
    expect(meta.onConflict).toBe('overwrite');
  });

  it("should default onConflict to 'error' when not set", () => {
    @blob('plain-uploads')
    @role('authenticated', 'read')
    class PlainUploads {}

    const meta = (PlainUploads as any)[Symbol.metadata]?.[
      Symbol.for('microsoft.rayfin.storage.folder')
    ];
    expect(meta.onConflict).toBe('error');
  });

  it('should reject invalid @blob options', () => {
    expect(() => blob({ onConflict: 'rename' as unknown as 'error' })).toThrow(
      /onConflict/
    );
  });

  it('should exclude partition from @blob options', () => {
    // @ts-expect-error partition strategy is not configurable
    blob({ partition: 'none' });
  });

  it('should support explicit relationship decorators', () => {
    expect(() => {
      @entity()
      class Category {
        @uuid()
        id!: string;

        @text()
        name!: string;

        @many(() => Post)
        posts!: Post[]; // Explicit one-to-many
      }

      @entity()
      class Post {
        @uuid()
        id!: string;

        @text()
        title!: string;

        @one(() => Category)
        category!: Category; // Explicit many-to-one + FK generation

        @one(() => User)
        author?: User; // Optional many-to-one relationship (relationships are optional by default)
      }
    }).not.toThrow();
  });

  describe('Field decorator options', () => {
    it('should accept unique option on text fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @text({ unique: true })
          uniqueSlug!: string;
        }
      }).not.toThrow();
    });

    it('should accept optional option on uuid fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @uuid({ optional: true })
          optionalId?: string;
        }
      }).not.toThrow();
    });

    it('should infer primary key from id field by convention', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @text()
          name!: string;
        }
      }).not.toThrow();
    });

    it('should accept default value option on boolean fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @boolean({ default: false })
          isActive!: boolean;

          @boolean({ default: true, optional: true })
          isVerified?: boolean;
        }
      }).not.toThrow();
    });

    it('should accept max and min options on text fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @text({ min: 3, max: 50 })
          username!: string;

          @text({ max: 255 })
          title!: string;
        }
      }).not.toThrow();
    });

    it('should accept regex option on text fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @text({ regex: /^[a-z0-9-]+$/ })
          slug!: string;
        }
      }).not.toThrow();
    });

    it('should accept max and min options on int fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @int({ min: 0, max: 100 })
          score!: number;

          @int({ min: 1 })
          priority!: number;
        }
      }).not.toThrow();
    });

    it('should accept max and min options on decimal fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @decimal({ min: 0, max: 999999.99 })
          price!: number;

          @decimal({ optional: true })
          discount?: number;
        }
      }).not.toThrow();
    });

    it('should accept multiple combined options on fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @text({ unique: true, min: 5, max: 50, regex: /^[a-zA-Z0-9]+$/ })
          username!: string;

          @int({ optional: true, min: 0, max: 10, default: 5 })
          rating?: number;

          @boolean({ optional: true, default: false })
          archived?: boolean;
        }
      }).not.toThrow();
    });

    it('should accept options on email fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @email({ unique: true })
          primaryEmail!: string;

          @email({ optional: true })
          secondaryEmail?: string;

          @email({ unique: true, max: 255 })
          workEmail!: string;
        }
      }).not.toThrow();
    });

    it('should accept options on date fields', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @date({ default: new Date() })
          createdAt!: Date;

          @date({ optional: true })
          updatedAt?: Date;
        }
      }).not.toThrow();
    });

    it('should accept options in set decorator (options object form)', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @set({ enum: ['active', 'inactive'], optional: true })
          status?: 'active' | 'inactive';

          @set({ enum: ['low', 'medium', 'high'], default: 'medium' })
          priority!: 'low' | 'medium' | 'high';
        }
      }).not.toThrow();
    });

    it('should accept options in set decorator (mixed form)', () => {
      expect(() => {
        @entity()
        class TestEntity {
          @uuid()
          id!: string;

          @set({ optional: true }, 'red', 'green', 'blue')
          color?: 'red' | 'green' | 'blue';

          @set({ unique: true }, 'pending', 'completed')
          state!: 'pending' | 'completed';
        }
      }).not.toThrow();
    });
  });
});

describe('Connector field options (column)', () => {
  it('stores column on @text fields', () => {
    @entity()
    class E {
      @uuid()
      id!: string;
      @text({ column: 'product_name' })
      name!: string;
    }
    const meta = getMeta(E);
    expect(meta.fields.name.columnName).toBe('product_name');
  });

  it('stores column on @int fields', () => {
    @entity()
    class E {
      @uuid()
      id!: string;
      @int({
        column: 'product_category_id',
      })
      categoryId!: number;
    }
    const meta = getMeta(E);
    expect(meta.fields.categoryId.columnName).toBe('product_category_id');
  });

  it('stores column on @uuid fields', () => {
    @entity()
    class E {
      @uuid({ column: 'row_guid' })
      id!: string;
    }
    const meta = getMeta(E);
    expect(meta.fields.id.columnName).toBe('row_guid');
  });

  it('stores column on @decimal fields', () => {
    @entity()
    class E {
      @uuid()
      id!: string;
      @decimal({ column: 'unit_price' })
      price!: number;
    }
    const meta = getMeta(E);
    expect(meta.fields.price.columnName).toBe('unit_price');
  });

  it('stores column on @boolean fields', () => {
    @entity()
    class E {
      @uuid()
      id!: string;
      @boolean({ column: 'is_active' })
      active!: boolean;
    }
    const meta = getMeta(E);
    expect(meta.fields.active.columnName).toBe('is_active');
  });

  it('stores column on @date fields', () => {
    @entity()
    class E {
      @uuid()
      id!: string;
      @date({ column: 'created_at' })
      createdAt!: Date;
    }
    const meta = getMeta(E);
    expect(meta.fields.createdAt.columnName).toBe('created_at');
  });

  it('stores column on @email fields', () => {
    @entity()
    class E {
      @uuid()
      id!: string;
      @email({ column: 'email_address' })
      email!: string;
    }
    const meta = getMeta(E);
    expect(meta.fields.email.columnName).toBe('email_address');
  });

  it('stores column on @set fields', () => {
    @entity()
    class E {
      @uuid()
      id!: string;
      @set({ column: 'priority_level' }, 'low', 'medium', 'high')
      priority!: 'low' | 'medium' | 'high';
    }
    const meta = getMeta(E);
    expect(meta.fields.priority.columnName).toBe('priority_level');
  });

  it('supports column names with spaces (per CORE-COLUMN-001 scenario)', () => {
    @entity()
    class E {
      @uuid()
      id!: string;
      @int({ column: 'Product Category ID' })
      categoryId!: number;
    }
    const meta = getMeta(E);
    expect(meta.fields.categoryId.columnName).toBe('Product Category ID');
  });

  it('omits columnName when not provided', () => {
    @entity()
    class E {
      @uuid()
      id!: string;
      @int()
      score!: number;
    }
    const meta = getMeta(E);
    expect(meta.fields.score.columnName).toBeUndefined();
  });
});
