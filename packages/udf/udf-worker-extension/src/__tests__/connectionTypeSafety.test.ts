import { describe, test, expect, jest } from '@jest/globals';

import { AudienceType } from '../types/connection.js';
import type { RayfinContext } from '../types/rayfinContext.js';

// ---------------------------------------------------------------------------
// Compile-time assertions for the inverted connection model.
//
// Generic connections are declared on the handler's context annotation:
// `RayfinContext<Schema, AudienceType.Sql>` both declares the binding and
// bounds `getToken`. The `connections` array no longer constrains the context.
//
// These are verified by `npm run lint`, NOT by `npm test` — tsconfig.json
// excludes `src/**/__tests__/**` and ts-jest transpiles without diagnostics
// (the shared base sets `isolatedModules: true`). `npm run lint` adds
// `tsc -p tsconfig.test.json`, where an `@ts-expect-error` that stops being
// necessary is reported as TS2578.
// ---------------------------------------------------------------------------

jest.unstable_mockModule('@microsoft/rayfin-client', () => ({
  RayfinServerClient: class {
    data = {};
  },
}));

jest.unstable_mockModule('@azure/functions', () => ({
  app: { http: () => {}, setup: () => {} },
  input: { generic: (opts: unknown) => opts },
}));

jest.unstable_mockModule('../astparser.js', () => ({
  TypeScriptProjectParser: class {
    scanProject() {}
    getAllFabricUdfFunctions() {
      return [];
    }
  },
}));

const { UserDataFunctions } = await import('../userDataFunctions.js');

type AppSchema = { Todo: { id: string; title: string } };

// This file asserts types rather than behavior, so it only needs an instance.
// There is no generated runtime metadata here, so the instance lands in the
// metadata error state — which is fine, because none of these handlers run.
const udf = new UserDataFunctions();

describe('context-declared generic connections', () => {
  test('getToken is bounded by the annotated audience union', () => {
    udf.func(
      'myFunc',
      async (
        ctx: RayfinContext<AppSchema, AudienceType.Sql | AudienceType.ADO>
      ) => {
        // @ts-expect-error AzureAI is not in the annotated union.
        ctx.getToken(AudienceType.AzureAI);
        ctx.getToken(AudienceType.ADO);
        return ctx.getToken(AudienceType.Sql);
      },
      []
    );

    expect(true).toBe(true);
  });

  test('the connections argument may be omitted entirely', () => {
    udf.func(
      'noThirdArgument',
      async (ctx: RayfinContext<AppSchema, AudienceType.Sql>) =>
        ctx.getToken(AudienceType.Sql)
    );

    expect(true).toBe(true);
  });

  test('a context with no annotated audiences cannot call getToken', () => {
    udf.func(
      'noAudience',
      async (ctx: RayfinContext<AppSchema>) => {
        // @ts-expect-error TokenTypes defaults to never.
        ctx.getToken(AudienceType.Sql);
        return ctx.getSecret('SOME_SECRET');
      },
      []
    );

    expect(true).toBe(true);
  });

  test('Tokens is narrowed to the annotated audiences', () => {
    udf.func(
      'tokensMap',
      async (ctx: RayfinContext<AppSchema, AudienceType.Fabric>) => {
        const fabricToken: string | undefined = ctx.Tokens.Fabric;
        // @ts-expect-error Storage is not annotated.
        ctx.Tokens.Storage;
        return fabricToken;
      },
      []
    );

    expect(true).toBe(true);
  });

  test('the schema type argument still flows to the data client', () => {
    udf.func(
      'schemaFlows',
      async (ctx: RayfinContext<AppSchema, AudienceType.Sql>) => {
        ctx.getToken(AudienceType.Sql);
        return ctx.getDataClient();
      },
      []
    );

    expect(true).toBe(true);
  });

  test('alias connections are still declared through the array', () => {
    udf.func(
      'aliasConnection',
      async (ctx: RayfinContext<AppSchema, AudienceType.Sql>) =>
        ctx.getToken(AudienceType.Sql),
      [udf.connection({ alias: 'myLakehouse' })]
    );

    expect(true).toBe(true);
  });

  test('generic connections in the array remain accepted for compatibility', () => {
    udf.func(
      'legacyArrayForm',
      async (ctx: RayfinContext<AppSchema, AudienceType.Fabric>) =>
        ctx.getToken(AudienceType.Fabric),
      [udf.connection({ audienceType: AudienceType.Fabric })]
    );

    expect(true).toBe(true);
  });

  test('handlers without a context still accept business parameters', () => {
    udf.func(
      'helloWorld',
      (firstName: string, lastName: string) =>
        `Hello ${firstName} ${lastName}!`,
      []
    );

    expect(true).toBe(true);
  });

  test('a shared handler keeps its own audience bound', () => {
    const handler = async (
      ctx: RayfinContext<AppSchema, AudienceType.Sql>
    ): Promise<string> => {
      // @ts-expect-error Storage is outside this handler's annotation.
      ctx.getToken(AudienceType.Storage);
      return ctx.getToken(AudienceType.Sql);
    };

    udf.func('sharedA', handler, []);
    udf.func('sharedB', handler, []);

    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The compile-time half of the declaration matrix.
//
// Runtime binding registration for every annotation/array combination is
// covered in userDataFunctions.test.ts. What matters here is which
// combinations grant *typed* access to a token — only the annotation does,
// because only the annotation exists in the type system.
// ---------------------------------------------------------------------------

describe('declaration sources and typed access', () => {
  test('annotation only — token access is allowed', () => {
    udf.func(
      'matrixAnnotationOnly',
      async (ctx: RayfinContext<AppSchema, AudienceType.Sql>) => {
        const viaMethod: string = ctx.getToken(AudienceType.Sql);
        const viaProperty: string = ctx.Tokens.Sql;
        return viaMethod === viaProperty;
      },
      []
    );

    expect(true).toBe(true);
  });

  test('array only — the binding is registered but access is NOT typed', () => {
    // This is the pre-change authoring style. The connection is still bound at
    // runtime (see userDataFunctions.test.ts), but the array is a runtime value
    // and contributes nothing to the type system, so the token cannot be
    // reached without widening the annotation.
    udf.func(
      'matrixArrayOnly',
      async (ctx: RayfinContext<AppSchema>) => {
        // @ts-expect-error declared in the array, but the annotation says nothing
        ctx.getToken(AudienceType.Sql);
        // @ts-expect-error same for property access
        ctx.Tokens.Sql;
        return 'ok';
      },
      [udf.connection({ audienceType: AudienceType.Sql })]
    );

    expect(true).toBe(true);
  });

  test('both, same audience — access is allowed and the array is redundant', () => {
    udf.func(
      'matrixBothSame',
      async (ctx: RayfinContext<AppSchema, AudienceType.Fabric>) =>
        ctx.Tokens.Fabric,
      [udf.connection({ audienceType: AudienceType.Fabric })]
    );

    expect(true).toBe(true);
  });

  test('both, different audiences — only the annotated one is reachable', () => {
    udf.func(
      'matrixBothDifferent',
      async (ctx: RayfinContext<AppSchema, AudienceType.Sql>) => {
        ctx.Tokens.Sql;
        // @ts-expect-error bound at runtime via the array, but not annotated
        ctx.Tokens.Fabric;
        return 'ok';
      },
      [udf.connection({ audienceType: AudienceType.Fabric })]
    );

    expect(true).toBe(true);
  });

  test('both, overlapping union — every annotated audience is reachable', () => {
    udf.func(
      'matrixOverlap',
      async (
        ctx: RayfinContext<AppSchema, AudienceType.Sql | AudienceType.Fabric>
      ) => {
        ctx.Tokens.Sql;
        ctx.Tokens.Fabric;
        // @ts-expect-error Storage is in the array only
        ctx.Tokens.Storage;
        return 'ok';
      },
      [
        udf.connection({ audienceType: AudienceType.Fabric }),
        udf.connection({ audienceType: AudienceType.Storage }),
      ]
    );

    expect(true).toBe(true);
  });

  test('alias only — no audiences, whatever the array contains', () => {
    udf.func(
      'matrixAliasOnly',
      async (ctx: RayfinContext<AppSchema>) => {
        // @ts-expect-error alias connections grant no generic token
        ctx.Tokens.Sql;
        return ctx.getSecret('S');
      },
      [udf.connection({ alias: 'myLakehouse' })]
    );

    expect(true).toBe(true);
  });

  test('neither — nothing is reachable', () => {
    udf.func(
      'matrixNeither',
      async (ctx: RayfinContext<AppSchema>) => {
        // @ts-expect-error nothing declared anywhere
        ctx.getToken(AudienceType.Sql);
        return ctx.getSecret('S');
      },
      []
    );

    expect(true).toBe(true);
  });
});
