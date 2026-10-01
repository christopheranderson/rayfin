import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  globalTimeout: 600000, // 10 min total for all tests
  timeout: 60000, // 60s per test
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: '../.temp/playwright-report', open: 'never' }],
  ],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
});
