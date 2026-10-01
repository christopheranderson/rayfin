/**
 * TEST CASE: Typos in Nested Fields
 *
 * Tests that typos in nested field names are properly rejected.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error
const test = client.OptionalManyRelationship.select(['posts.contentt']); // extra 't'

export {};
