/**
 * Shared connector entity fixtures, reusable across the connectors test suite.
 *
 * These `@entity()` classes extend `Source(...)`, so their constructor type
 * carries the `RayfinPrimaryKey` brand and satisfies `EntityClass`. Keeping
 * them in one module avoids re-declaring the same shapes per test file.
 */

import { entity, decimal, int, text, uuid } from '@microsoft/rayfin-core';

import { Source } from '../../category-a/schema/source';

/** Property names differ from DB column names, which is the interesting case. */
@entity()
export class Product extends Source({
  table: 'Product',
  primaryKey: ['productId'],
}) {
  @uuid({ column: 'ProductID' })
  productId!: string;

  @text({ column: 'Name' })
  name!: string;

  @decimal({ column: 'Price', precision: 18, scale: 2 })
  price!: number;
}

/** A field whose DB column name differs from its property name. */
@entity()
export class Renamed extends Source({ table: 'Renamed', primaryKey: ['id'] }) {
  @int({ column: 'Id' })
  id!: number;

  @text({ column: 'email_address' })
  email!: string;
}
