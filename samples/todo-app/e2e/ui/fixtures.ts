/* eslint-disable no-empty-pattern */
import { test as base, expect } from '@playwright/test';

import { getFrontendUrl } from '../shared/frontend';
import { generateUniqueUser, type TestUser } from '../shared/test-data';

/**
 * Custom fixtures for todo-app E2E tests
 */
type TodoAppFixtures = {
  /** URL of the shared frontend server selected by the Rayfin workflow */
  frontendUrl: string;
  /** Unique test user credentials for this test */
  testUser: TestUser;
};

/**
 * Extended Playwright test with todo-app specific fixtures
 */
export const test = base.extend<TodoAppFixtures>({
  /**
   * Frontend URL fixture
   * Returns the runtime URL exported by Playwright global setup
   */
  frontendUrl: async ({}, use) => {
    await use(getFrontendUrl());
  },

  /**
   * Test user fixture
   * - Generates unique credentials for each test
   * - Ensures tests don't conflict with each other
   */
  testUser: async ({}, use) => {
    const user = generateUniqueUser();
    await use(user);
  },
});

export { expect };
