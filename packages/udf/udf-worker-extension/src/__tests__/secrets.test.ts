import { describe, test, expect, afterEach } from '@jest/globals';

import { RayfinContext, type RayfinInfo } from '../types/rayfinContext.js';
import type { RegisteredSecretNames } from '../types/secretsRegistry.js';

// ---------------------------------------------------------------------------
// Secrets reach the type system through declaration merging: the CLI generates
// a file that augments `RayfinSecretRegistry`, and `RayfinContext`'s third type
// parameter defaults to whatever is registered.
//
// This suite augments the registry itself, exactly as a generated file would,
// so the default-parameter path is exercised rather than a hand-passed union.
// ---------------------------------------------------------------------------

declare module '../types/secretsRegistry.js' {
  interface RayfinSecretRegistry {
    API_KEY: string;
    DB_PASSWORD: string;
  }
}

const rayfinInfo: RayfinInfo = {
  rayfinToken: 'rayfin-token',
  publishableKey: 'publishable-key',
  rayFinEndpoint: 'https://rayfin.example.com',
};

type Todo = { id: string; title: string };
/** An ordinary schema — no secrets, no symbol keys, nothing added. */
type AppSchema = { Todo: Todo };

describe('secrets via the registry', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('type-level registration', () => {
    test('registered names become the default secret union', () => {
      const declared: RegisteredSecretNames = 'API_KEY';
      const alsoDeclared: RegisteredSecretNames = 'DB_PASSWORD';
      // @ts-expect-error not registered by any generated file
      const notDeclared: RegisteredSecretNames = 'NOPE';

      expect([declared, alsoDeclared, notDeclared]).toHaveLength(3);
    });
  });

  describe('Secrets property', () => {
    test('an unchanged annotation picks up the registry', () => {
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
          DB_PASSWORD: 'header-db-password',
        }
      );

      // Typed `string`, not `string | undefined`.
      const apiKey: string = context.Secrets.API_KEY;
      expect(apiKey).toBe('header-api-key');
      expect(context.Secrets.DB_PASSWORD).toBe('header-db-password');
    });

    test('works on a bare context, with no schema at all', () => {
      const context = new RayfinContext(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
        }
      );

      const apiKey: string = context.Secrets.API_KEY;
      expect(apiKey).toBe('header-api-key');
    });

    test('rejects a secret that was never registered', () => {
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
        }
      );

      expect(() => {
        // @ts-expect-error NOT_DECLARED is not in the registry.
        context.Secrets.NOT_DECLARED;
      }).toThrow(/No value available for secret 'NOT_DECLARED'/);
    });

    test('the third type parameter can narrow a single function', () => {
      const context = new RayfinContext<AppSchema, never, 'API_KEY'>(
        rayfinInfo,
        {},
        { API_KEY: 'header-api-key', DB_PASSWORD: 'header-db-password' }
      );

      expect(context.Secrets.API_KEY).toBe('header-api-key');
      expect(() => {
        // @ts-expect-error deliberately narrowed away from this context.
        context.Secrets.DB_PASSWORD;
      }).not.toThrow();
    });

    test('falls back to process.env, as getSecret does', () => {
      // The reason Secrets cannot be a snapshot of the header: locally,
      // secrets arrive as environment variables.
      process.env.DB_PASSWORD = 'env-db-password';
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
        }
      );

      expect(context.Secrets.API_KEY).toBe('header-api-key');
      expect(context.Secrets.DB_PASSWORD).toBe('env-db-password');
      expect(context.Secrets.DB_PASSWORD).toBe(
        context.getSecret('DB_PASSWORD')
      );
    });

    test('prefers the header over process.env', () => {
      process.env.API_KEY = 'env-api-key';
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
        }
      );

      expect(context.Secrets.API_KEY).toBe('header-api-key');
    });

    test('an empty-string header secret does not fall through to the environment', () => {
      // Matches getSecret's `??` semantics: '' is a real value.
      process.env.API_KEY = 'env-api-key';
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: '',
        }
      );

      expect(context.Secrets.API_KEY).toBe('');
      expect(context.getSecret('API_KEY')).toBe('');
    });

    test('throws when a registered secret was never supplied', () => {
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
        }
      );

      // Would otherwise hand back `undefined` from a `string`-typed property.
      expect(() => context.Secrets.DB_PASSWORD).toThrow(
        /No value available for secret 'DB_PASSWORD'/
      );
      // getSecret keeps its lenient contract.
      expect(context.getSecret('DB_PASSWORD')).toBeUndefined();
    });

    test('inspection and serialization report only supplied header secrets', () => {
      process.env.DB_PASSWORD = 'env-db-password';
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
        }
      );

      expect(Object.keys(context.Secrets)).toEqual(['API_KEY']);
      expect(JSON.stringify(context.Secrets)).toBe(
        '{"API_KEY":"header-api-key"}'
      );
      expect({ ...context.Secrets }).toEqual({ API_KEY: 'header-api-key' });
      expect(() => String(context.Secrets)).not.toThrow();
    });

    test('runtime protocol probes are not treated as secret lookups', () => {
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
        }
      );
      const secrets = context.Secrets as unknown as Record<string, unknown>;

      // `then` is the dangerous one: awaiting or resolving a promise with this
      // object probes it, so intercepting it would throw far from the cause.
      expect(() => secrets.then).not.toThrow();
      expect(secrets.then).toBeUndefined();
      expect(() => secrets.toJSON).not.toThrow();
      expect(() => secrets.toString).not.toThrow();
      expect(() => secrets.hasOwnProperty).not.toThrow();
    });

    test('the secrets object survives being awaited', async () => {
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
        }
      );

      const resolved = await Promise.resolve(context.Secrets);
      expect(resolved.API_KEY).toBe('header-api-key');
    });

    test('`in` accounts for the environment fallback', () => {
      process.env.DB_PASSWORD = 'env-db-password';
      const context = new RayfinContext<AppSchema>(
        rayfinInfo,
        {},
        {
          API_KEY: 'header-api-key',
        }
      );

      expect('API_KEY' in context.Secrets).toBe(true);
      expect('DB_PASSWORD' in context.Secrets).toBe(true);
      expect('NEVER_SET' in context.Secrets).toBe(false);
    });
  });

  describe('the data client is untouched by secrets', () => {
    test('getDataClient still reflects the schema exactly', () => {
      // No EntitiesOf stripping is needed any more: the schema never carries
      // secrets, so there is nothing to strip.
      const context = new RayfinContext<AppSchema>(rayfinInfo, {}, {});
      expect(typeof context.getDataClient).toBe('function');
    });
  });
});
