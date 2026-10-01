import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';
// Load .env file for local development (CI sets these via pipeline variables)
import { config } from 'dotenv';
config({ path: resolve(import.meta.dirname, '.env') });

export default defineConfig({
  testDir: './src/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  globalTimeout: 600_000, // 10 min total
  timeout: 300_000, // 5 min per test (deployment is slow)
  retries: process.env.CI ? 1 : 0,
  workers: 1, // sequential — tests share a deployment
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    clientCertificates: process.env.E2E_CERT_PATH
      ? [
          {
            origin: 'https://certauth.login.microsoftonline.com',
            pfxPath: process.env.E2E_CERT_PATH,
          },
        ]
      : [],
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
