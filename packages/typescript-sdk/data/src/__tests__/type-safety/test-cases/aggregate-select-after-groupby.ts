/**
 * TEST CASE: select() called after groupBy()
 *
 * Grouped aggregation and row selection are mutually exclusive in Data
 * API Builder. `groupBy()` narrows its return type to omit the row-only
 * methods (`select`, `orderBy`, `first`, `after`), so calling `select()`
 * after `groupBy()` must not type-check.
 *
 * This test should FAIL to compile with TypeScript errors.
 */

import type { ApiClient } from '@microsoft/rayfin-lib';

import { createDataApi } from '../../../index';

import type { TypeSafetyTestSchema } from './shared-types';

const client = createDataApi<TypeSafetyTestSchema>({} as ApiClient);

// ❌ Should cause TypeScript compilation error — groupBy() strips the
// row-only methods (select/orderBy/first/after) from the returned builder.
const test = client.RequiredOneRelationship.groupBy(['id']).select(['id']);

export {};
