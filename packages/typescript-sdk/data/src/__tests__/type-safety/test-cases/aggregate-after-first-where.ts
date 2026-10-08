/**
 * TEST CASE: aggregate() called after first().where()
 *
 * Pagination and grouped aggregation are mutually exclusive in Data API
 * Builder. `first()` narrows the builder to the row-query surface, and a
 * subsequent `where()` on that surface must stay on it rather than widening
 * back to the full builder. So `aggregate()` after `first(...).where(...)`
 * must not type-check.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error — the row surface returned by
// first() keeps where() on the row surface, so aggregate() is unavailable.
const test = client.RequiredOneRelationship.first(10)
  .where({ status: { eq: 'open' } })
  .aggregate({
    n: { count: 'id' },
  });

export {};
