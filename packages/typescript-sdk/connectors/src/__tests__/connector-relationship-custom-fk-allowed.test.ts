/**
 * POSITIVE REFERENCE: custom-FK options are allowed on CONNECTOR relationships,
 * and a plain data-path relationship (no custom FK) is always allowed.
 *
 * A connector entity extends `Source({...})`, so its constructor carries the
 * static `RayfinPrimaryKey` brand. The `@one`/`@many` overloads key off the
 * relationship target's brand: when the target is a connector entity, the
 * custom-FK options (`sourceFields`/`targetFields`) are accepted.
 *
 * This file MUST compile. If it ever fails, the guard is over-restrictive.
 * The connector-path `Source` marker now lives in `@microsoft/rayfin-connectors`
 * (this package), so the classes below are typechecked by vitest's typecheck
 * pass rather than the data package's tsc harness.
 */

import { entity, int, uuid, one, many } from '@microsoft/rayfin-core';
import { describe, it } from 'vitest';

import { Source } from '../category-a/schema/source';

@entity()
class City extends Source({ table: 'City', primaryKey: ['id'] }) {
  @int()
  id!: number;
}

@entity()
class ConnectorOrder extends Source({ table: 'Orders', primaryKey: ['id'] }) {
  @int()
  id!: number;

  @int()
  cityId!: number;

  // ✅ connector target -> custom FK options are allowed
  @one(() => City, { sourceFields: ['cityId'], targetFields: ['id'] })
  city!: City;
}

@entity()
class ConnectorCity extends Source({ table: 'City', primaryKey: ['id'] }) {
  @int()
  id!: number;

  // ✅ inverse side, custom FK options allowed on @many too
  @many(() => ConnectorOrder, {
    sourceFields: ['id'],
    targetFields: ['cityId'],
  })
  orders!: ConnectorOrder[];
}

// A connector relationship with NO custom FK is also allowed — sourceFields /
// targetFields are optional on connector entities, not required.
@entity()
class ConnectorSupplier extends Source({
  table: 'Supplier',
  primaryKey: ['id'],
}) {
  @int()
  id!: number;

  // ✅ connector target, no custom FK options -> allowed
  @one(() => City)
  city!: City;

  // ✅ connector target, @many with no custom FK options -> allowed
  @many(() => ConnectorOrder)
  orders!: ConnectorOrder[];
}

// Plain data-path entities: a relationship with NO custom FK is always allowed.
// (Data-path entities use `id: string` per the data-path `id` convention.)
@entity()
class Region {
  @uuid()
  id!: string;
}

@entity()
class DataOrder {
  @uuid()
  id!: string;

  // ✅ no custom FK -> allowed on the data path
  @one(() => Region)
  region!: Region;
}

export { ConnectorOrder, ConnectorCity, ConnectorSupplier, DataOrder };

// The guarantee is compile-time: if any declaration above stops type-checking,
// vitest's typecheck pass fails. This runtime placeholder just gives the suite
// a collectable test.
describe('connector relationship custom FK (positive, must compile)', () => {
  it('type-checks the declarations in this file', () => {});
});
