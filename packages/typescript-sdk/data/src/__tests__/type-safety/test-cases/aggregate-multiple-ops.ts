/**
 * TEST CASE: Aggregation entry with more than one op
 *
 * The exactly-one-op union should reject a fresh literal that specifies
 * two operations in the same entry.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error — two ops in one entry.
const test = client.RequiredOneRelationship.groupBy(['status']).aggregate({
  bogus: { sum: 'amount', avg: 'amount' },
});

export {};
