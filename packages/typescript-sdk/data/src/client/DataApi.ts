import type { ApiClient as ApiClientType } from '@microsoft/rayfin-lib';
import { ApiClient } from '@microsoft/rayfin-lib';

import { GraphQLClient } from '../graphql/GraphQLClient';
import { GraphQLEntityClient } from '../graphql/GraphQLEntityClient';
import type { EntitySchema } from '../graphql/types';

/**
 * Type-safe data clients based on entity schema.
 */
export type TypedDataClients<TSchema extends EntitySchema> = {
  [K in keyof TSchema]: GraphQLEntityClient<TSchema, K>;
};

/**
 * Data-specific operations client for interacting with Data API Builder GraphQL endpoints.
 *
 * Use the `createDataApi` factory function to create instances instead of instantiating directly.
 *
 * @typeParam TSchema - Object type mapping entity names to their types
 */
export class DataApi<TSchema extends EntitySchema = Record<string, any>> {
  private apiClient: ApiClient;
  private clientCache = new Map<string, GraphQLEntityClient<any, any>>();

  /**
   * Creates a data API client. Prefer the `createDataApi` factory over calling
   * this constructor directly.
   *
   * @param apiClient - The underlying HTTP client used to issue GraphQL requests.
   */
  constructor(apiClient: ApiClientType) {
    this.apiClient = apiClient;

    // Return a Proxy that generates GraphQL clients on-demand
    return this.createProxy() as this & TypedDataClients<TSchema>;
  }

  /**
   * Get a GraphQL client for a specific entity.
   *
   * @param entityName - The entity name to get a client for (a key of `TSchema`).
   * @returns A typed {@link GraphQLEntityClient} for the entity. Clients are cached per entity.
   */
  getClient<K extends keyof TSchema>(
    entityName: K
  ): GraphQLEntityClient<TSchema, K> {
    const name = String(entityName);

    if (!this.clientCache.has(name)) {
      const graphqlClient = new GraphQLClient(this.apiClient, `/graphql`);
      this.clientCache.set(
        name,
        new GraphQLEntityClient(graphqlClient, entityName)
      );
    }

    return this.clientCache.get(name)!;
  }

  /**
   * Get all available entity names.
   * In a Proxy-based client, this returns all entity names that have been accessed.
   *
   * @returns The list of entity names for which clients have been created.
   */
  getEntityNames(): (keyof TSchema)[] {
    return Array.from(this.clientCache.keys()) as (keyof TSchema)[];
  }

  /**
   * Create a Proxy that generates GraphQL clients on-demand.
   */
  private createProxy(): TypedDataClients<TSchema> & DataApi<TSchema> {
    return new Proxy(this as any, {
      get: (target, prop) => {
        // Allow access to class methods and properties
        if (prop in target) {
          return target[prop as keyof DataApi<TSchema>];
        }

        // Generate entity client for string properties
        if (typeof prop === 'string') {
          return this.getClient(prop as keyof TSchema);
        }

        return undefined;
      },

      ownKeys: () => {
        // Return only entity names for Object.keys() etc.
        return Array.from(this.clientCache.keys());
      },

      has: (target, prop) => {
        // Check class properties first
        if (prop in target) {
          return true;
        }
        // Always return true for string properties (entity names)
        return typeof prop === 'string';
      },

      getOwnPropertyDescriptor: (target, prop) => {
        if (typeof prop === 'string') {
          return {
            enumerable: true,
            configurable: true,
            value: this.getClient(prop as keyof TSchema),
          };
        }

        return undefined;
      },
    });
  }
}

/**
 * Create a type-safe DataApi instance for interacting with Data API Builder GraphQL endpoints.
 *
 * @typeParam TSchema - Object type mapping entity names to their types
 * @param apiClient - The ApiClient instance for making HTTP requests
 * @returns A fully typed DataApi instance with direct entity access
 *
 * @example
 * ```typescript
 * const dataApi = createDataApi<{
 *   User: User;
 *   Organization: Organization;
 * }>(apiClient);
 *
 * // GraphQL fluent interface (direct entity access):
 * const activeUsers = await dataApi.User
 *   .select(['id', 'name', 'email'])
 *   .where({ isActive: { eq: true } })
 *   .orderBy({ createdAt: 'desc' })
 *   .execute();
 *
 * // GraphQL mutations:
 * const newUser = await dataApi.User.create({
 *   email: 'user@example.com',
 *   name: 'Jane Doe'
 * });
 * ```
 */
export function createDataApi<TSchema extends EntitySchema>(
  apiClient: ApiClientType
): DataApi<TSchema> & TypedDataClients<TSchema> {
  return new DataApi<TSchema>(apiClient) as DataApi<TSchema> &
    TypedDataClients<TSchema>;
}
