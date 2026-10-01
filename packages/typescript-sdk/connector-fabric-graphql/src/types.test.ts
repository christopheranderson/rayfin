import { RayfinPrimaryKey } from '@microsoft/rayfin-connectors';
import type {
  ConnectorEntityClient,
  DbOperationResult,
  WhereUniqueOf,
} from '@microsoft/rayfin-connectors';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  CrudOperation,
  GraphQLBackedConnector,
  RestrictedDataApi,
  RestrictedEntityClient,
} from './types';

// A keyless schema: bare instance types with no `Source` primary-key phantom,
// so every entity resolves `WhereUniqueOf` to `never`.
interface Product {
  id: string;
  name: string;
}

interface Customer {
  id: string;
  email: string;
}

type Schema = { Product: Product; Customer: Customer };

// A keyed schema: the entry is the entity *constructor* carrying the static
// `RayfinPrimaryKey` phantom, exactly as `Source({ primaryKey: [...] })` emits.
interface Reading {
  sensorId: string;
  metricCode: string;
  value: number;
}

type ReadingEntity = (abstract new (...args: never[]) => Reading) & {
  readonly [RayfinPrimaryKey]: readonly ['sensorId', 'metricCode'];
};

type KeyedSchema = { Reading: ReadingEntity };

describe('CrudOperation', () => {
  it('is the union of the four CRUD verbs', () => {
    expectTypeOf<CrudOperation>().toEqualTypeOf<
      'read' | 'create' | 'update' | 'delete'
    >();
  });
});

describe('RestrictedEntityClient CRUD-op gating (keyed entity)', () => {
  it('with TOps = "read" exposes only read methods', () => {
    type Reader = RestrictedEntityClient<KeyedSchema, 'Reading', 'read'>;
    expectTypeOf<Reader>().toHaveProperty('select');
    expectTypeOf<Reader>().toHaveProperty('where');
    expectTypeOf<Reader>().toHaveProperty('orderBy');
    expectTypeOf<Reader>().toHaveProperty('first');
    expectTypeOf<Reader>().toHaveProperty('findMany');
    expectTypeOf<Reader>().toHaveProperty('findFirst');
    expectTypeOf<Reader>().toHaveProperty('findByKey');
    expectTypeOf<Reader>().not.toHaveProperty('create');
    expectTypeOf<Reader>().not.toHaveProperty('update');
    expectTypeOf<Reader>().not.toHaveProperty('delete');
  });

  it('with TOps = "create" exposes only create', () => {
    type Writer = RestrictedEntityClient<KeyedSchema, 'Reading', 'create'>;
    expectTypeOf<Writer>().toHaveProperty('create');
    expectTypeOf<Writer>().not.toHaveProperty('select');
    expectTypeOf<Writer>().not.toHaveProperty('findMany');
    expectTypeOf<Writer>().not.toHaveProperty('update');
    expectTypeOf<Writer>().not.toHaveProperty('delete');
  });

  it('with TOps = "read" | "create" exposes the union', () => {
    type RW = RestrictedEntityClient<KeyedSchema, 'Reading', 'read' | 'create'>;
    expectTypeOf<RW>().toHaveProperty('select');
    expectTypeOf<RW>().toHaveProperty('findMany');
    expectTypeOf<RW>().toHaveProperty('findByKey');
    expectTypeOf<RW>().toHaveProperty('create');
    expectTypeOf<RW>().not.toHaveProperty('update');
    expectTypeOf<RW>().not.toHaveProperty('delete');
  });

  it('with TOps = full CrudOperation exposes every entity-client method', () => {
    type Full = RestrictedEntityClient<KeyedSchema, 'Reading', CrudOperation>;
    expectTypeOf<Full>().toHaveProperty('select');
    expectTypeOf<Full>().toHaveProperty('where');
    expectTypeOf<Full>().toHaveProperty('orderBy');
    expectTypeOf<Full>().toHaveProperty('first');
    expectTypeOf<Full>().toHaveProperty('findMany');
    expectTypeOf<Full>().toHaveProperty('findFirst');
    expectTypeOf<Full>().toHaveProperty('findByKey');
    expectTypeOf<Full>().toHaveProperty('create');
    expectTypeOf<Full>().toHaveProperty('update');
    expectTypeOf<Full>().toHaveProperty('delete');
  });

  it('preserves the underlying ConnectorEntityClient method signatures', () => {
    type Reader = RestrictedEntityClient<KeyedSchema, 'Reading', 'read'>;
    // findByKey on the restricted client should return the same signature as
    // on ConnectorEntityClient - Pick preserves the original signature.
    expectTypeOf<Reader['findByKey']>().toEqualTypeOf<
      ConnectorEntityClient<KeyedSchema, 'Reading'>['findByKey']
    >();
  });
});

describe('RestrictedEntityClient primary-key gating', () => {
  it('a keyless entity does not expose the by-key methods at all', () => {
    type Full = RestrictedEntityClient<Schema, 'Product', CrudOperation>;
    expectTypeOf<Full>().not.toHaveProperty('findByKey');
    expectTypeOf<Full>().not.toHaveProperty('update');
    expectTypeOf<Full>().not.toHaveProperty('delete');
    // the key-agnostic surface is unaffected
    expectTypeOf<Full>().toHaveProperty('create');
    expectTypeOf<Full>().toHaveProperty('select');
    expectTypeOf<Full>().toHaveProperty('where');
    expectTypeOf<Full>().toHaveProperty('orderBy');
    expectTypeOf<Full>().toHaveProperty('first');
    expectTypeOf<Full>().toHaveProperty('findMany');
    expectTypeOf<Full>().toHaveProperty('findFirst');
  });

  it('a keyed entity exposes the by-key methods', () => {
    type Full = RestrictedEntityClient<KeyedSchema, 'Reading', CrudOperation>;
    expectTypeOf<Full>().toHaveProperty('findByKey');
    expectTypeOf<Full>().toHaveProperty('update');
    expectTypeOf<Full>().toHaveProperty('delete');
  });
});

describe('RestrictedDataApi<Schema, TOps>', () => {
  it('maps each entity key to a RestrictedEntityClient', () => {
    type Api = RestrictedDataApi<Schema, 'read'>;
    expectTypeOf<Api>().toHaveProperty('Product');
    expectTypeOf<Api>().toHaveProperty('Customer');
    expectTypeOf<Api['Product']>().toEqualTypeOf<
      RestrictedEntityClient<Schema, 'Product', 'read'>
    >();
    expectTypeOf<Api['Customer']>().toEqualTypeOf<
      RestrictedEntityClient<Schema, 'Customer', 'read'>
    >();
  });
});

describe('GraphQLBackedConnector<Schema, TConfig>', () => {
  it('defaults ops to the full CrudOperation union and dialect to entity rows', () => {
    type Marker = GraphQLBackedConnector<KeyedSchema>;
    type Api = NonNullable<Marker['__client']>;
    // Default config ⇒ every CRUD method is exposed.
    expectTypeOf<Api['Reading']>().toHaveProperty('findMany');
    expectTypeOf<Api['Reading']>().toHaveProperty('create');
    expectTypeOf<Api['Reading']>().toHaveProperty('update');
    expectTypeOf<Api['Reading']>().toHaveProperty('delete');
  });

  it('derives the permitted ops from the config operations tuple', () => {
    type ReadOnlyConfig = {
      connector: 'fabric-sqldatabase';
      operations: readonly ['read'];
    };
    type Marker = GraphQLBackedConnector<KeyedSchema, ReadOnlyConfig>;
    type Api = NonNullable<Marker['__client']>;
    expectTypeOf<Api['Reading']>().toHaveProperty('findMany');
    expectTypeOf<Api['Reading']>().not.toHaveProperty('create');
    expectTypeOf<Api['Reading']>().not.toHaveProperty('update');
    expectTypeOf<Api['Reading']>().not.toHaveProperty('delete');
  });

  it('derives the dialect from the config: warehouse mutations return DbOperationResult', () => {
    type WarehouseConfig = {
      connector: 'fabric-warehouse';
      operations: readonly ['read', 'update'];
    };
    type Marker = GraphQLBackedConnector<KeyedSchema, WarehouseConfig>;
    type Api = NonNullable<Marker['__client']>;
    // Warehouse has no read-after-write ⇒ update resolves to DbOperationResult.
    expectTypeOf<
      Awaited<ReturnType<Api['Reading']['update']>>
    >().toEqualTypeOf<DbOperationResult>();
  });

  it('a read-after-write dialect returns the entity row from mutations', () => {
    type SqlConfig = {
      connector: 'fabric-sqldatabase';
      operations: readonly ['read', 'update'];
    };
    type Marker = GraphQLBackedConnector<KeyedSchema, SqlConfig>;
    type Api = NonNullable<Marker['__client']>;
    expectTypeOf<
      Awaited<ReturnType<Api['Reading']['update']>>
    >().not.toEqualTypeOf<DbOperationResult>();
  });

  it('carries TSchema and TConfig as phantoms accessible via infer', () => {
    type Cfg = { connector: 'fabric-warehouse'; operations: readonly ['read'] };
    type Marker = GraphQLBackedConnector<Schema, Cfg>;
    type ExtractedSchema =
      Marker extends GraphQLBackedConnector<infer S, infer _> ? S : never;
    type ExtractedConfig =
      Marker extends GraphQLBackedConnector<infer _, infer C> ? C : never;
    expectTypeOf<ExtractedSchema>().toEqualTypeOf<Schema>();
    expectTypeOf<ExtractedConfig>().toEqualTypeOf<Cfg>();
  });
});

describe('WhereUniqueOf<T>', () => {
  it('is an exact Pick over a declared composite key', () => {
    expectTypeOf<WhereUniqueOf<ReadingEntity>>().toEqualTypeOf<{
      sensorId: string;
      metricCode: string;
    }>();
  });

  it('is an exact Pick over a declared single-column key', () => {
    type Todo = { id: string; title: string };
    type TodoEntity = (abstract new (...args: never[]) => Todo) & {
      readonly [RayfinPrimaryKey]: readonly ['id'];
    };
    expectTypeOf<WhereUniqueOf<TodoEntity>>().toEqualTypeOf<{ id: string }>();
  });

  it('is `never` for a keyless entity (empty key tuple)', () => {
    type TodoEntity = (abstract new (...args: never[]) => {
      id: string;
    }) & { readonly [RayfinPrimaryKey]: readonly [] };
    expectTypeOf<WhereUniqueOf<TodoEntity>>().toEqualTypeOf<never>();
  });

  it('is `never` for a bare instance with no key phantom', () => {
    expectTypeOf<WhereUniqueOf<Product>>().toEqualTypeOf<never>();
  });

  it('is `never` when a declared key column does not exist on the instance', () => {
    // `ide` is a typo — the real field is `id`. Previously this collapsed to
    // `{}` (accepts any object); now the whole shape is `never`.
    type TodoEntity = (abstract new (...args: never[]) => {
      id: string;
    }) & { readonly [RayfinPrimaryKey]: readonly ['ide'] };
    expectTypeOf<WhereUniqueOf<TodoEntity>>().toEqualTypeOf<never>();
  });

  it('is `never` for a partial composite key (some columns missing)', () => {
    // Only `sensorId` exists on the instance; `metricCode` cannot resolve, so
    // the whole declared key is rejected rather than silently narrowed.
    type PartialEntity = (abstract new (...args: never[]) => {
      sensorId: string;
      value: number;
    }) & { readonly [RayfinPrimaryKey]: readonly ['sensorId', 'metricCode'] };
    expectTypeOf<WhereUniqueOf<PartialEntity>>().toEqualTypeOf<never>();
  });
});
