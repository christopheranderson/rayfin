import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.{test,spec}.{js,ts}',
      'scripts/**/*.{test,spec}.{js,ts}',
    ],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
