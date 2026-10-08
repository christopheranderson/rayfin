import { describe, test, expect } from '@jest/globals';

import { AUDIENCE_SCOPE_OVERRIDES } from '../types/audienceScopes.js';
import { Connection, AudienceType } from '../types/connection.js';
import type { AudiencesOf } from '../types/connection.js';
import { RayfinContext, type RayfinInfo } from '../types/rayfinContext.js';
import { UserDataFunctions } from '../userDataFunctions.js';

const rayfinInfo: RayfinInfo = {
  rayfinToken: 'rayfin-token',
  publishableKey: 'publishable-key',
  rayFinEndpoint: 'https://rayfin.example.com',
};

describe('AudienceType', () => {
  test('exposes only supported audiences', () => {
    expect(Object.values(AudienceType).sort()).toEqual([
      'ADO',
      'AzureAI',
      'Fabric',
      'Sql',
      'Storage',
    ]);
  });

  test('retired audiences are excluded from the public type', () => {
    type RetiredAudience =
      | 'CosmosDB'
      | 'Kusto'
      | 'KeyVault'
      | 'WorkIQ'
      | 'EventGrid';
    const noRetiredMembers: [
      Extract<keyof typeof AudienceType, RetiredAudience>,
    ] extends [never]
      ? true
      : false = true;

    expect(noRetiredMembers).toBe(true);
  });

  test('retains scope overrides independently of the public audience enum', () => {
    expect(AUDIENCE_SCOPE_OVERRIDES).toEqual({
      [AudienceType.AzureAI]: 'https://ai.azure.com/user_impersonation',
      [AudienceType.ADO]: '499b84ac-1321-427f-aa17-267ca6975798/.default',
      Kusto: 'https://kusto.kusto.windows.net/user_impersonation',
      WorkIQ: 'https://workiq.svc.cloud.microsoft/mcp/.default',
    });
  });
});

describe('Connection', () => {
  describe('generic connections (audienceType)', () => {
    test('creates a generic connection with audienceType', () => {
      const conn = new Connection({ audienceType: AudienceType.Fabric });
      expect(conn.audienceType).toBe('Fabric');
      expect(conn.isGeneric).toBe(true);
      expect(conn.alias).toBeUndefined();
      expect(conn.argName).toBeUndefined();
    });

    test('connection factory preserves the audience type', () => {
      const conn = UserDataFunctions.prototype.connection({
        audienceType: AudienceType.Fabric,
      });
      const typedConnection: Connection<AudienceType.Fabric> = conn;

      expect(typedConnection.audienceType).toBe(AudienceType.Fabric);
    });

    test('connection factory rejects audience strings outside AudienceType', () => {
      // @ts-expect-error Generic connections require an AudienceType member.
      UserDataFunctions.prototype.connection({ audienceType: 'Fabric' });

      expect(true).toBe(true);
    });
  });

  describe('alias connections', () => {
    test('creates an alias connection with alias and argName', () => {
      const conn = new Connection({ alias: 'myLakehouse', argName: 'lake' });
      expect(conn.alias).toBe('myLakehouse');
      expect(conn.argName).toBe('lake');
      expect(conn.isGeneric).toBe(false);
      expect(conn.audienceType).toBeUndefined();
    });

    test('argName defaults to alias when omitted', () => {
      const conn = new Connection({ alias: 'myLakehouse' });
      expect(conn.alias).toBe('myLakehouse');
      expect(conn.argName).toBe('myLakehouse');
      expect(conn.isGeneric).toBe(false);
    });
  });

  describe('typed token access', () => {
    test('restricts getToken to the context audience type', () => {
      const context = new RayfinContext<
        Record<string, never>,
        AudienceType.Fabric
      >(rayfinInfo, { [AudienceType.Fabric]: 'fabric-token' });

      expect(context.getToken(AudienceType.Fabric)).toBe('fabric-token');
      expect(() =>
        // @ts-expect-error Sql was not declared on this context.
        context.getToken(AudienceType.Sql)
      ).toThrow(/No token available for audience 'Sql'/);
    });

    test('supports a union of declared audience types', () => {
      const context = new RayfinContext<
        Record<string, never>,
        AudienceType.Fabric | AudienceType.Sql
      >(rayfinInfo, {
        [AudienceType.Fabric]: 'fabric-token',
        [AudienceType.Sql]: 'sql-token',
      });

      expect(context.getToken(AudienceType.Fabric)).toBe('fabric-token');
      expect(context.getToken(AudienceType.Sql)).toBe('sql-token');
      expect(() =>
        // @ts-expect-error Storage was not declared on this context.
        context.getToken(AudienceType.Storage)
      ).toThrow(/No token available for audience 'Storage'/);
    });

    test('a context with no declared audiences cannot request any token', () => {
      const context = new RayfinContext<Record<string, never>>(rayfinInfo, {
        [AudienceType.Sql]: 'sql-token',
      });

      // @ts-expect-error TokenTypes defaults to never — nothing was declared.
      expect(context.getToken(AudienceType.Sql)).toBe('sql-token');
      // @ts-expect-error Tokens is narrowed to the declared audiences.
      expect(context.Tokens.Sql).toBe('sql-token');
    });
    test('Tokens exposes declared audiences as properties', () => {
      const context = new RayfinContext<
        Record<string, never>,
        AudienceType.Fabric | AudienceType.Sql
      >(rayfinInfo, {
        [AudienceType.Fabric]: 'fabric-token',
        [AudienceType.Sql]: 'sql-token',
      });

      // Typed `string`, not `string | undefined`.
      const fabricToken: string = context.Tokens.Fabric;
      expect(fabricToken).toBe('fabric-token');
      expect(context.Tokens.Sql).toBe('sql-token');
      // @ts-expect-error Storage was not declared on this context.
      expect(context.Tokens.Storage).toBeUndefined();
    });

    test('Tokens and getToken agree', () => {
      const context = new RayfinContext<
        Record<string, never>,
        AudienceType.Sql
      >(rayfinInfo, { [AudienceType.Sql]: 'sql-token' });

      expect(context.Tokens.Sql).toBe(context.getToken(AudienceType.Sql));
    });

    test('a declared audience that produced no token throws on property access', () => {
      // Declared (so the binding was registered) but the host minted nothing.
      const context = new RayfinContext<
        Record<string, never>,
        AudienceType.Sql | AudienceType.Fabric
      >(rayfinInfo, { [AudienceType.Fabric]: 'fabric-token' }, {}, [
        AudienceType.Sql,
        AudienceType.Fabric,
      ]);

      expect(context.Tokens.Fabric).toBe('fabric-token');
      // The `string` type would otherwise be a lie here.
      expect(() => context.Tokens.Sql).toThrow(
        /No token available for audience 'Sql'/
      );
      expect(() => context.getToken(AudienceType.Sql)).toThrow(
        /No token available for audience 'Sql'/
      );
    });

    test('an unminted audience stays out of enumeration and serialization', () => {
      const context = new RayfinContext<
        Record<string, never>,
        AudienceType.Sql | AudienceType.Fabric
      >(rayfinInfo, { [AudienceType.Fabric]: 'fabric-token' }, {}, [
        AudienceType.Sql,
        AudienceType.Fabric,
      ]);

      // Inspecting or serializing the map must not detonate, and must report
      // only the tokens that actually exist.
      expect(Object.keys(context.Tokens)).toEqual(['Fabric']);
      expect(JSON.stringify(context.Tokens)).toBe('{"Fabric":"fabric-token"}');
      expect({ ...context.Tokens }).toEqual({ Fabric: 'fabric-token' });
    });

    test('a narrower context cannot satisfy one declaring more audiences', () => {
      // Pins the variance of TokenTypes directly, independently of which
      // member happens to enforce it (the exact `Tokens` Record and the
      // `__audienceVariance` phantom field both do). This is what stops a
      // context being passed to a helper that needs an audience it never
      // declared.
      const narrow = new RayfinContext<Record<string, never>, never>(
        rayfinInfo,
        {}
      );

      // @ts-expect-error a context declaring nothing cannot stand in for one declaring Sql.
      const wide: RayfinContext<
        Record<string, never>,
        AudienceType.Sql
      > = narrow;

      // The safe direction is allowed: declaring more than is required.
      const declaresSql = new RayfinContext<
        Record<string, never>,
        AudienceType.Sql
      >(rayfinInfo, { [AudienceType.Sql]: 'sql-token' });
      const requiresNothing: RayfinContext<
        Record<string, never>,
        never
      > = declaresSql;

      expect([wide, requiresNothing]).toHaveLength(2);
    });

    test('getToken throws when a declared audience produced no token', () => {
      const context = new RayfinContext<
        Record<string, never>,
        AudienceType.Sql
      >(rayfinInfo, {});

      expect(() => context.getToken(AudienceType.Sql)).toThrow(
        /No token available for audience 'Sql'/
      );
    });
  });

  describe('AudiencesOf', () => {
    test('collects audiences from generic connections', () => {
      const connections = [
        new Connection({ audienceType: AudienceType.Sql }),
        new Connection({ audienceType: AudienceType.Fabric }),
      ] as const;

      type Audiences = AudiencesOf<typeof connections>;
      const declared: Audiences = AudienceType.Sql;
      const alsoDeclared: Audiences = AudienceType.Fabric;
      // @ts-expect-error Storage is not part of the declared connections.
      const notDeclared: Audiences = AudienceType.Storage;

      expect([declared, alsoDeclared, notDeclared]).toHaveLength(3);
    });

    test('alias connections contribute no audiences', () => {
      const connections = [new Connection({ alias: 'myLakehouse' })] as const;

      type Audiences = AudiencesOf<typeof connections>;
      const isNever: [Audiences] extends [never] ? true : false = true;

      expect(isNever).toBe(true);
    });
  });
});
