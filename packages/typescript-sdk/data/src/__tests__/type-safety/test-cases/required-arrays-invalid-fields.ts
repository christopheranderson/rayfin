/**
 * TEST CASE: Required Arrays - Invalid Nested Fields
 *
 * Tests that required array relationships also reject invalid nested fields.
 * Complements the optional arrays test case.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error
const test = client.RequiredManyRelationship.select([
  'id',
  'posts.invalidField',
]);

export {};
