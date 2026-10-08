import { RayfinClient } from '@microsoft/rayfin-client';

import type { TodoAppSchema } from '../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../rayfin/storage/schema';

import { getBackendUrl } from './backend';

const RAYFIN_PUBLISHABLE_KEY = 'pk-commonSampleAppPKkey';

/**
 * Create a new RayfinClient instance for E2E tests
 * @returns Initialized RayfinClient configured for local backend
 */
export function createTestClient(): RayfinClient<
  TodoAppSchema,
  TodoAppStorageSchema
> {
  const baseUrl = getBackendUrl();
  console.log(`Using base URL: ${baseUrl}`);
  return new RayfinClient<TodoAppSchema, TodoAppStorageSchema>({
    baseUrl,
    publishableKey: RAYFIN_PUBLISHABLE_KEY,
    headers: {
      'Content-Type': 'application/json',
    },
    authStorage: false, // Disable localStorage for Node.js environment (memory-only sessions)
  });
}
