/**
 * TEST CASE: aggregate() called after select()
 *
 * Row-selection and grouped aggregation are mutually exclusive in Data
 * API Builder. `select()` narrows its return type to omit `aggregate`
 * and `groupBy`, so this chain must not type-check.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error — select() strips
// aggregate/groupBy from the returned builder type.
const test = client.RequiredOneRelationship.select(['id']).aggregate({
  n: { count: 'id' },
});

export {};
