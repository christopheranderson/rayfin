/**
 * TEST CASE: Aggregation references an unknown field
 *
 * The `field` argument must be a known key of the entity; a typo or
 * unknown name must not type-check.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error — 'nope' is not a field.
const test = client.RequiredOneRelationship.groupBy(['status']).aggregate({
  x: { avg: 'nope' },
});

export {};
