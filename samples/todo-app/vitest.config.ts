import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});

// This config does not work in the pipelines, but it allows running the Vitests
// in the Testing pane of VSCode locally.
// export default defineConfig({
//   plugins: [react()],
//   test: {
//     projects: [
//       {
//         extends: true,
//         test: {
//           name: 'Todo App Unit Tests',
//           globals: true,
//           environment: 'jsdom',
//           include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
//           exclude: ['node_modules', 'dist', 'e2e'],
//           setupFiles: ['./src/__tests__/setup.ts'],
//         },
//       },
//       {
//         extends: 'e2e/api/vitest.config.ts',
//       },
//     ],
//   },
// });
