/**
 * TEST CASE: Optional Objects - Invalid Nested Fields
 *
 * Tests that optional object relationships reject invalid nested fields.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error
const test = client.OptionalOneRelationship.select([
  'id',
  'category.invalidField',
]);

export {};
