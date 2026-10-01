import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      autoCodeSplitting: true,
    }), // File-based routing support
    react(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0'),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react/')
          ) {
            return 'vendor';
          }
          if (id.includes('@tanstack/react-router')) {
            return 'router';
          }
          if (
            id.includes('@tanstack/react-table') ||
            id.includes('@tanstack/react-query')
          ) {
            return 'ui';
          }
          if (id.includes('react-icons')) {
            return 'icons';
          }
        },
      },
    },
  },
});
