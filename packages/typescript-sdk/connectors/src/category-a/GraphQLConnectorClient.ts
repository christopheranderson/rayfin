/**
 * Per-connector GraphQL-backed client (Category A).
 *
 * Backs `client.connectors.<name>` for connectors whose data is served
 * over a DAB-style GraphQL endpoint at
 * `${CONNECTOR_GRAPHQL_RUNTIME_BASE_PATH}/<name>/graphql`.
 *
 * The constructor returns a Proxy so `client.connectors.<name>.<Entity>`
 * resolves to a {@link ConnectorEntityClient} for that entity — mirroring
 * the `DataApi` pattern in `@microsoft/rayfin-data`. Entity clients are
 * cached per entity name on first access.
 *
 * When `operations` is supplied, each entity client is wrapped in a
 * runtime gating Proxy that throws `ConnectorsError('OPERATION_NOT_ALLOWED')`
 * for methods whose CRUD verb is not in the allow-list. This is
 * defense-in-depth — the primary gating is compile-time via
 * `GraphQLBackedConnector<TSchema, TConfig>` /
 * `RestrictedEntityClient<...>` in
 * `@microsoft/rayfin-connector-fabric-graphql`.
 *
 * @example
 * ```ts
 * const products = await client.connectors.salesDb.Product
 *   .select(['id', 'name'])
 *   .where({ price: { gt: 10 } })
 *   .execute();
 * ```
 */

import type { EntityClass } from '@microsoft/rayfin-core';
import { GraphQLClient } from '@microsoft/rayfin-data';
import {
  ApiClient,
  CONNECTOR_GRAPHQL_RUNTIME_BASE_PATH,
} from '@microsoft/rayfin-lib';
import type { ConnectorType } from '@microsoft/rayfin-tools-common/_internal/config';

import { ConnectorsError } from '../Connectors';
import {
  METHODS_FOR_CRUD_OPERATION,
  type CrudOperation,
} from '../ConnectorsSchema';

import { ConnectorEntityClient } from './ConnectorEntityClient';

export class GraphQLConnectorClient {
  private readonly graphqlClient: GraphQLClient;
  private readonly connectorName: string;
  private readonly connectorType: ConnectorType;
  private readonly entityCache = new Map<
    string,
    ConnectorEntityClient<any, any>
  >();
  /**
   * CRUD-method names that are NOT permitted by this connector's
   * `operations` allow-list. Populated only when `operations` was
   * supplied; otherwise `undefined` and gating is skipped entirely.
   * Method names absent from `METHODS_FOR_CRUD_OPERATION`
   * (internal helpers) are never in this set and therefore
   * always pass through.
   */
  private readonly disallowedMethods: ReadonlySet<string> | undefined;

  /**
   * Per-entity default selection, from the connector's generated
   * `connectorConfig.entities`. Either the decorated class or an explicit
   * column list; the column list is what browser code should supply. Optional
   * — absent for older generated schemas or untyped callers, in which case
   * no-selection reads throw and mutations return only the mutated columns.
   */
  private readonly entities:
    | Record<string, EntityClass | readonly string[]>
    | undefined;

  constructor(
    apiClient: ApiClient,
    connectorName: string,
    connectorType: ConnectorType,
    operations?: readonly CrudOperation[],
    entities?: Record<string, EntityClass | readonly string[]>
  ) {
    const endpoint = `${CONNECTOR_GRAPHQL_RUNTIME_BASE_PATH}/${connectorName}/graphql`;
    this.graphqlClient = new GraphQLClient(apiClient, endpoint);
    this.connectorName = connectorName;
    this.connectorType = connectorType;
    this.disallowedMethods = operations
      ? this.computeDisallowedMethods(operations)
      : undefined;
    this.entities = entities;

    return this.createProxy();
  }

  private computeDisallowedMethods(
    operations: readonly CrudOperation[]
  ): ReadonlySet<string> {
    const allowedVerbs = new Set<CrudOperation>(operations);
    const disallowed = new Set<string>();
    for (const [verb, methods] of Object.entries(
      METHODS_FOR_CRUD_OPERATION
    ) as [CrudOperation, readonly string[]][]) {
      if (allowedVerbs.has(verb)) continue;
      for (const method of methods) disallowed.add(method);
    }
    return disallowed;
  }

  /**
   * Lazily build and cache a {@link ConnectorEntityClient} for `entityName`.
   * Wraps the client in a CRUD-gating Proxy when `operations` was set.
   */
  private getEntityClient(entityName: string): ConnectorEntityClient<any, any> {
    let client = this.entityCache.get(entityName);
    if (!client) {
      const raw = new ConnectorEntityClient(
        this.graphqlClient,
        entityName,
        this.connectorType,
        this.entities?.[entityName]
      );
      client = this.disallowedMethods
        ? this.gateEntityClient(raw, entityName)
        : raw;
      this.entityCache.set(entityName, client);
    }
    return client;
  }

  private gateEntityClient(
    raw: ConnectorEntityClient<any, any>,
    entityName: string
  ): ConnectorEntityClient<any, any> {
    const disallowed = this.disallowedMethods!;
    const connectorName = this.connectorName;
    return new Proxy(raw, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && disallowed.has(prop)) {
          return () => {
            throw new ConnectorsError(
              `Operation "${prop}" on connector "${connectorName}" entity "${entityName}" is not in the connector's allowed operations.`,
              'OPERATION_NOT_ALLOWED'
            );
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  private createProxy(): this {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop !== 'string') {
          return Reflect.get(target, prop, receiver);
        }
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return target.getEntityClient(prop);
      },
      has: (target, prop) => {
        if (typeof prop === 'string' && !(prop in target)) {
          return true;
        }
        return Reflect.has(target, prop);
      },
    });
  }
}
