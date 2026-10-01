/**
 * TEST CASE: Invalid Top-Level Fields
 *
 * Tests that completely invalid top-level fields are rejected.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error
const test = client.OptionalManyRelationship.select(['invalidTopLevel']);

export {};
