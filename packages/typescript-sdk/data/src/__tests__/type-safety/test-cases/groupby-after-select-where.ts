/**
 * TEST CASE: groupBy() called after select().where()
 *
 * Row-selection and grouped aggregation are mutually exclusive in Data API
 * Builder. `select()` narrows the builder to the row-query surface, and a
 * subsequent `where()` on that surface must stay on it rather than widening
 * back to the full builder. So `groupBy()` after `select(...).where(...)`
 * must not type-check.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error — the row surface returned by
// select() keeps where() on the row surface, so groupBy() is unavailable.
const test = client.RequiredOneRelationship.select(['id'])
  .where({ status: { eq: 'open' } })
  .groupBy(['status']);

export {};
