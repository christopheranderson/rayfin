/**
 * TEST CASE: count() on a non-numeric field
 *
 * Data API Builder types every aggregation's `field` argument (including
 * `count`) as the `<Entity>NumericAggregateFields` enum, so `count` only
 * accepts numeric fields — a non-numeric field such as `status` must be
 * rejected, exactly like `sum`/`avg`/`min`/`max`.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error — 'status' is a string field
// and count only accepts numeric fields.
const test = client.RequiredOneRelationship.groupBy(['status']).aggregate({
  n: { count: 'status' },
});

export {};
