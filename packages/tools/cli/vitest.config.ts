import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: true,
    hookTimeout: 30_000,
    include: [
      'src/**/*.{test,spec}.{js,ts}',
      'scripts/**/*.{test,spec}.{js,ts}',
    ],
    exclude: ['node_modules', 'dist', 'templates', 'src/__tests__/e2e/**'],
    testTimeout: 30_000,
  },
});
