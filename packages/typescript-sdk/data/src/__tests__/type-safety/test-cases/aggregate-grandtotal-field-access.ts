/**
 * TEST CASE: accessing a scalar field on a grand-total aggregation row
 *
 * A grand-total aggregation (`aggregate()` with no `groupBy()`) returns rows
 * whose `fields` is the empty object `{}` at runtime. The type must reflect
 * that, so reading a scalar such as `fields.amount` — which would be
 * `undefined` at runtime — must not type-check.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

async function run() {
  const rows = await client.RequiredOneRelationship.aggregate({
    total: { sum: 'amount' },
  }).execute();

  // ❌ Should cause TypeScript compilation error — grand-total rows carry no
  // grouped keys, so `fields` is `{}` and `amount` is not a property.
  return rows[0].fields.amount;
}

void run;

export {};
