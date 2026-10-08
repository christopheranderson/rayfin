import { ensureBackendRunning } from '../shared/backend';
import {
  E2E_FRONTEND_URL_ENV_VAR,
  resolveFrontendUrl,
  waitForFrontend,
} from '../shared/frontend';

/**
 * Global setup for Playwright UI tests
 * Starts the shared Rayfin backend before all tests
 * (Vite frontend is managed by Playwright's webServer config)
 */
export default async function globalSetup() {
  console.log('🚀 Starting shared Rayfin backend...');
  await ensureBackendRunning();
  const frontendUrl = resolveFrontendUrl();
  process.env[E2E_FRONTEND_URL_ENV_VAR] = frontendUrl;
  await waitForFrontend(frontendUrl);
  console.log('✅ Backend ready for UI tests');
}
