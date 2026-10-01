import { describe, it, expect } from 'vitest';

import { ConfigGenerator } from '../analysis/dab-config-generator.js';
import { DatabaseDialect } from '../analysis/dialect-config.js';
import { SchemaAnalyzer } from '../analysis/schema-analyzer.js';
import {
  entity,
  uuid,
  text,
  boolean,
  date,
  role,
} from '../decorators/decorators.js';
import type { ComplexAction, PermissionConfig } from '../options.js';

@entity()
@role('anonymous', 'read')
@role('authenticated', ['read', 'update'], {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
  exclude: ['secret'],
})
class SecureDoc {
  @uuid()
  id!: string;

  @uuid()
  owner_id!: string;

  @text()
  secret?: string;
}

describe('Permissions aggregation', () => {
  it('aggregates roles, policies, includes, and excludes deterministically', () => {
    const analyzer = new SchemaAnalyzer([SecureDoc], DatabaseDialect.MsSql);
    const [result] = analyzer.analyzeEntities();
    const expected: PermissionConfig = {
      anonymous: ['read'],
      authenticated: [
        {
          action: 'read',
          policy: { database: '@claims.sub eq @item.owner_id' },
          fields: { include: ['*'], exclude: ['secret'] },
        },
        {
          action: 'update',
          policy: { database: '@claims.sub eq @item.owner_id' },
          fields: { include: ['*'], exclude: ['secret'] },
        },
      ],
    };

    expect(result.permissions).toEqual(expected);
  });

  it('handles scenario with exclude-only fields', () => {
    @entity()
    @role('authenticated', '*', {
      policy: (claims, item) => {
        // @ts-expect-error - ItemProxy must be typed to entity fields only
        item.RANDOM_FIELD;
        return claims.sub.eq(item.id);
      },
    })
    @role('authenticated', 'read', {
      policy: (_claims, item) => item.IsAdmin.eq(false),
      exclude: ['last_login'],
    })
    class Account {
      @uuid()
      id!: string;

      @text()
      name!: string;

      @boolean()
      IsAdmin!: boolean;

      @date()
      last_login!: Date;
    }

    const analyzer = new SchemaAnalyzer([Account], DatabaseDialect.MsSql);
    const [result] = analyzer.analyzeEntities();

    const auditorPerm = result.permissions.authenticated.find(
      (action): action is ComplexAction => typeof action !== 'string'
    );
    expect(auditorPerm?.fields).toEqual({
      include: ['*'],
      exclude: ['last_login'],
    });
  });

  it('honors include precedence when include and exclude are present', () => {
    @entity()
    @role('authenticated', ['read'], {
      include: ['field'],
      exclude: ['field'],
    })
    class Mixed {
      @uuid()
      id!: string;

      @text()
      field!: string;
    }

    const analyzer = new SchemaAnalyzer([Mixed], DatabaseDialect.MsSql);
    const [result] = analyzer.analyzeEntities();
    const perms = result.permissions.authenticated as any[];
    expect(perms[0].fields.include).toEqual(['field']);
    expect(perms[0].fields.exclude).toEqual(['field']);
  });

  it('emits sorted DAB config permissions with deterministic ordering', () => {
    const analyzer = new SchemaAnalyzer([SecureDoc], DatabaseDialect.MsSql);
    const [result] = analyzer.analyzeEntities();
    const generator = new ConfigGenerator(DatabaseDialect.MsSql);
    const config = generator.generateConfig([result]);
    const perms = config.entities[result.name].permissions;

    expect(perms.map((p) => p.role)).toEqual(['anonymous', 'authenticated']);
    expect(perms[1].actions).toHaveLength(2);
    expect(perms[1].actions[0]).toEqual({
      action: 'read',
      policy: { database: '@claims.sub eq @item.owner_id' },
      fields: { include: ['*'], exclude: ['secret'] },
    });
  });
});
