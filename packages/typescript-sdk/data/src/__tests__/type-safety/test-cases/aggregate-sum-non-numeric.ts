/**
 * TEST CASE: sum() over a non-numeric field
 *
 * `sum`/`avg`/`min`/`max` are constrained to `NumericKeys<T>`; supplying a
 * string field must not type-check.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error — 'status' is a string field.
const test = client.RequiredOneRelationship.groupBy(['status']).aggregate({
  x: { sum: 'status' },
});

export {};
