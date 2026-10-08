import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    exclude: ['node_modules', 'dist'],
    typecheck: {
      enabled: true,
      include: ['src/**/*.test.ts'],
      tsconfig: './tsconfig.test.json',
    },
  },
});
