import { stopBackend } from '../shared/backend';

/**
 * Global teardown for Playwright UI tests
 * Stops the shared workflow session (backend and Vite) after all tests complete.
 */
export default async function globalTeardown() {
  if (process.env.E2E_KEEP_BACKEND_RUNNING !== 'true') {
    await stopBackend();
  } else {
    console.log('⏸️ Keeping backend running (E2E_KEEP_BACKEND_RUNNING=true)');
  }
}
