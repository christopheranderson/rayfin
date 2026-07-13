import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { rayfinLocalDev } from '@workspace-todo-app/local-dev/vite';

// `rayfinLocalDev` fronts the remote backend on a same-origin `/.rayfin/` path
// and, when a local Azure Functions host (`func start`) is detected, reroutes
// function calls to it. `auth.enabled` also exposes the Fabric auth proxy so a
// WebView-hosted app can log in via the system browser. See
// @workspace-todo-app/local-dev for details.
export default defineConfig({
  plugins: [react(), rayfinLocalDev({ auth: { enabled: true } })],
});
