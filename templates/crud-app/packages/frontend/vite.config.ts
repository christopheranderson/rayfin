import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { rayfinLocalDev } from '@workspace-todo-app/local-dev/vite';
import { resolve } from 'path';
import { defineConfig, loadEnv } from 'vite';

const projectRoot = process.env.PROJECT_ROOT || import.meta.dirname;

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Pin the dev server to Rayfin's per-project port (VITE_PORT, mapped from
  // RAYFIN_PUBLIC_FRONTEND_PORT in .env.local) so multiple local frontends
  // don't collide and the deployed backend can allow-list one stable origin.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const port = env.VITE_PORT ? Number(env.VITE_PORT) : undefined;

  return {
    plugins: [
      react(),
      tailwindcss(),
      // `rayfinLocalDev` fronts the remote backend on a same-origin `/.rayfin/`
      // path and, when a local Azure Functions host (`func start`) is detected,
      // reroutes function calls to it. `auth.enabled` also exposes the Fabric
      // auth proxy so a WebView-hosted app can log in via the system browser.
      // See @workspace-todo-app/local-dev for details.
      rayfinLocalDev({ auth: { enabled: true } }),
    ],
    resolve: {
      alias: {
        '@': resolve(projectRoot, 'src'),
      },
    },
    ...(port ? { server: { port, strictPort: true } } : {}),
    build: {
      // Target ES2022 for modern JavaScript decorators
      target: 'es2022',
    },
    esbuild: {
      target: 'es2022',
    },
    optimizeDeps: {
      esbuildOptions: {
        target: 'es2022',
      },
    },
  };
});
