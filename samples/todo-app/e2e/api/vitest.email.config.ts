import path from 'path';

import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for email-related tests.
 *
 * Email tests require a backend with AUTH_EMAIL_ENABLED=true, which starts the MailDev container.
 * These tests run separately after main tests to allow backend reconfiguration.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: path.resolve(__dirname),
    include: ['**/email.spec.ts', '**/magic-link.spec.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 60000,
    hookTimeout: 150000, // Allow 150s for backend startup in beforeAll
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
