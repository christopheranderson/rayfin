import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: 'Todo App E2E - Refresh Token (Absolute Lifetime)',
    globals: true,
    environment: 'node',
    root: path.resolve(__dirname),
    include: ['**/refresh-token.spec.ts'],
    testTimeout: 120000, // 2 minutes — allows absolute lifetime expiry test
    hookTimeout: 150000,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
