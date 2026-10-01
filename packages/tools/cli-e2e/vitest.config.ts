import { resolve } from 'node:path';

import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load .env file for local development (CI sets these via pipeline variables)
config({ path: resolve(import.meta.dirname, '.env') });

export default defineConfig({
  test: {
    globalSetup: ['./src/global-setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'src/browser'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'cobertura'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
