import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: 'Todo App E2E API Tests',
    globals: true,
    environment: 'node',
    root: path.resolve(__dirname),
    include: ['**/*.spec.ts'],
    exclude: [
      'node_modules',
      'dist',
      '**/email.spec.ts',
      '**/magic-link.spec.ts',
    ], // Email/magic-link tests run separately with different backend config
    testTimeout: 60000, // 60s per test
    hookTimeout: 150000, // Allow 150s for backend startup in beforeAll (health check is 120s)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // Serial execution for single backend instance
      },
    },
  },
});
