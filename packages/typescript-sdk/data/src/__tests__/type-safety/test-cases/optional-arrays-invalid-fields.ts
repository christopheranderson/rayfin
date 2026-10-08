/**
 * TEST CASE: Optional Arrays - Invalid Nested Fields
 *
 * This was the original bug - optional arrays incorrectly
 * allowed invalid nested field selections.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error
const test = client.OptionalManyRelationship.select([
  'id',
  'posts.invalidField',
]);

export {};
