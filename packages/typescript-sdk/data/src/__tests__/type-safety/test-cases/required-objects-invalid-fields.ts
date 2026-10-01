/**
 * TEST CASE: Required Objects - Invalid Nested Fields
 *
 * Tests that required object relationships also reject invalid nested fields.
 * Complements the optional objects test case.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error
const test = client.RequiredOneRelationship.select([
  'id',
  'category.invalidField',
]);

export {};
