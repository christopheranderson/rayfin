/**
 * @packageDocumentation Functions API for invoking serverless functions.
 *
 * The single public surface is `client.functions.<name>.invoke(...)` where
 * `<name>` is constrained by the `FunctionsSchema` type parameter passed to
 * `RayfinClient`.
 *
 * ```ts
 * const res = await client.functions.helloWorld.invoke({ firstName: 'Ada' });
 * ```
 */

import { ApiClient, SdkError } from '@microsoft/rayfin-lib';

import { FunctionClient } from './FunctionClient';
import type { FunctionsSchema } from './FunctionsSchema';

export { FunctionClient } from './FunctionClient';
export type {
  FunctionInvocationResponse,
  InvokeOptions,
} from './FunctionClient';

/**
 * Functions error specific to the Rayfin SDK.
 */
export class FunctionsError extends SdkError {
  constructor(message: string, code?: string) {
    super(message, code || 'FUNCTIONS_ERROR');
  }
}

/**
 * Mapped type that produces one `FunctionClient` property per schema entry.
 *
 * `client.functions` resolves to this type — every key in `TSchema` becomes
 * a strongly-typed per-function client whose `invoke()` signature matches
 * the schema entry.
 */
export type TypedFunctionClients<TSchema extends FunctionsSchema> = {
  [K in keyof TSchema & string]: FunctionClient<
    TSchema[K]['input'],
    TSchema[K]['output']
  >;
};

/**
 * Create a typed `client.functions` proxy that lazily instantiates and caches
 * a {@link FunctionClient} per schema-defined function name.
 *
 * ```ts
 * const fns = createFunctionsApi<MyFunctionsSchema>(apiClient);
 * const res = await fns.helloWorld.invoke({ firstName: 'Ada' });
 * ```
 */
export function createFunctionsApi<
  TSchema extends FunctionsSchema = FunctionsSchema,
>(apiClient: ApiClient): TypedFunctionClients<TSchema> {
  const cache = new Map<string, FunctionClient<any, any>>();

  const get = (name: string): FunctionClient<any, any> => {
    let client = cache.get(name);
    if (!client) {
      client = new FunctionClient(apiClient, name);
      cache.set(name, client);
    }
    return client;
  };

  return new Proxy(Object.create(null) as TypedFunctionClients<TSchema>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return get(prop);
    },

    has(_target, prop) {
      return typeof prop === 'string';
    },

    ownKeys() {
      return Array.from(cache.keys());
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return {
        enumerable: true,
        configurable: true,
        value: get(prop),
      };
    },
  });
}
