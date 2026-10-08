import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, type Page, type Response } from '@playwright/test';
import { parse } from 'yaml';

import {
  type FabricE2EConfig,
  authMode,
  loadFabricE2EConfig,
} from '../helpers/env';
import {
  cleanupStaleTestArtifacts,
  createTestArtifact,
  deleteTestArtifact,
} from '../helpers/fabric-api';
import {
  loginScaffoldAndDeploy,
  parseDeploymentsRegistry,
  parseRayfinEnvVars,
} from '../helpers/scaffold-template';

import { createTempDir, runCli, runCreateRayfin } from './cli-helpers';

/**
 * End-to-end browser tests that scaffold templates, deploy them to Fabric,
 * validate the deployment outputs, and then open the hostingUrl in a
 * browser to confirm the endpoint is reachable without errors.
 */

// ─── File-level artifact lifecycle ────────────────────────────────────────────

let artifactId: string;
let artifactName: string;
let workspaceId: string;

let dataappArtifactId: string;
let dataappArtifactName: string;
let dataappWorkspaceId: string;

let config: FabricE2EConfig;
let tempDir: string;
let projectDir: string;
let fabricApiUrl: string;
let hostingUrl: string;

const hasRequiredEnv = Boolean(
  process.env['E2E_ENVIRONMENT'] &&
  process.env['E2E_TENANT_ID'] &&
  (authMode === 'user' ||
    (process.env['E2E_CLIENT_ID'] && process.env['E2E_CLIENT_SECRET']))
);

const shouldRun = hasRequiredEnv;

const hostingReadinessTimeoutMs = 120_000;
const navigationAttemptTimeoutMs = 30_000;
const navigationRetryDelayMs = 5_000;

async function navigateToReachableHostingUrl(
  page: Page,
  url: string,
  onRetry?: () => void
): Promise<Response> {
  const deadline = Date.now() + hostingReadinessTimeoutMs;
  let lastFailure = 'no response';

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();

    try {
      const response = await page.goto(url, {
        waitUntil: 'commit',
        timeout: Math.min(navigationAttemptTimeoutMs, remainingMs),
      });

      if (response && response.status() < 500) {
        await page.waitForLoadState('domcontentloaded', {
          timeout: Math.max(1, deadline - Date.now()),
        });
        return response;
      }

      lastFailure = response ? `HTTP ${response.status()}` : 'no response';
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    const retryDelayMs = Math.min(
      navigationRetryDelayMs,
      deadline - Date.now()
    );
    if (retryDelayMs <= 0) break;

    onRetry?.();
    console.log(
      `[fabric-deploy] Hosting URL not ready (${lastFailure}), retrying in ${retryDelayMs / 1000}s...`
    );
    await page.waitForTimeout(retryDelayMs);
  }

  throw new Error(
    `Hosting URL did not become reachable within ${hostingReadinessTimeoutMs / 1000}s. Last failure: ${lastFailure}`
  );
}

test.beforeAll(async () => {
  if (!shouldRun) return;

  config = loadFabricE2EConfig();

  await cleanupStaleTestArtifacts(config);

  // Create dedicated test artifacts before running any tests
  console.log('[fabric-deploy] Creating test artifacts...');
  const artifact = await createTestArtifact({
    environment: config.environment,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tenantId: config.tenantId,
    workspaceName: config.workspaceName,
    tag: 'brw',
  });

  artifactId = artifact.artifactId;
  artifactName = artifact.artifactName;
  workspaceId = artifact.workspaceId;

  console.log(
    `[fabric-deploy] Created artifact: ${artifactName} (id=${artifactId}, workspace=${workspaceId})`
  );

  const dataappArtifact = await createTestArtifact({
    environment: config.environment,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tenantId: config.tenantId,
    workspaceName: config.workspaceName,
    tag: 'brw-data',
  });

  dataappArtifactId = dataappArtifact.artifactId;
  dataappArtifactName = dataappArtifact.artifactName;
  dataappWorkspaceId = dataappArtifact.workspaceId;

  console.log(
    `[fabric-deploy] Created dataapp artifact: ${dataappArtifactName} (id=${dataappArtifactId}, workspace=${dataappWorkspaceId})`
  );

  // Scaffold and deploy using the pre-created artifact
  const temp = createTempDir();
  tempDir = temp.dir;

  const runners = { runCli, runCreateRayfin };
  const result = await loginScaffoldAndDeploy({
    config: { ...config, artifactName, artifactId, workspaceId },
    tempDir,
    template: 'todoapp',
    runners,
  });
  projectDir = result.projectDir;

  // Extract fabricApiUrl and hostingUrl from .deployments.json
  const { deployment } = parseDeploymentsRegistry(projectDir);
  expect(deployment.fabricApiUrl).toBeTruthy();
  expect(deployment.hostingUrl).toBeTruthy();

  fabricApiUrl = deployment.fabricApiUrl as string;
  hostingUrl = deployment.hostingUrl as string;
});

test.afterAll(async () => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }

  if (artifactId && workspaceId) {
    console.log(`[fabric-deploy] Deleting test artifact: ${artifactName}...`);
    try {
      await deleteTestArtifact({
        environment: config.environment,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        tenantId: config.tenantId,
        workspaceId,
        artifactId,
      });
      console.log(`[fabric-deploy] Deleted artifact: ${artifactName}`);
    } catch (error) {
      console.error(`[fabric-deploy] Failed to delete artifact: ${error}`);
    }
  }

  if (dataappArtifactId && dataappWorkspaceId) {
    console.log(
      `[fabric-deploy] Deleting dataapp artifact: ${dataappArtifactName}...`
    );
    try {
      await deleteTestArtifact({
        environment: config.environment,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        tenantId: config.tenantId,
        workspaceId: dataappWorkspaceId,
        artifactId: dataappArtifactId,
      });
      console.log(
        `[fabric-deploy] Deleted dataapp artifact: ${dataappArtifactName}`
      );
    } catch (error) {
      console.error(
        `[fabric-deploy] Failed to delete dataapp artifact: ${error}`
      );
    }
  }
});

test('deployment env outputs are valid', () => {
  test.skip(!shouldRun, 'Skipped: Fabric E2E env vars not configured');

  // Validate .deployments.json
  const { deployment } = parseDeploymentsRegistry(projectDir);

  expect(deployment.fabricItemId).toEqual(expect.any(String));
  expect((deployment.fabricItemId as string).length).toBeGreaterThan(0);
  expect(deployment.fabricApiUrl).toEqual(expect.any(String));
  expect((deployment.fabricApiUrl as string).length).toBeGreaterThan(0);
  expect(deployment.fabricWorkspaceId).toEqual(expect.any(String));
  expect((deployment.fabricWorkspaceId as string).length).toBeGreaterThan(0);
  expect(deployment.deployedAt).toEqual(expect.any(String));
  expect(new Date(deployment.deployedAt as string).toISOString()).toBe(
    deployment.deployedAt
  );
  expect(deployment.publishableKey).toBeDefined();

  // Validate RAYFIN_PUBLIC_* values in rayfin/.env
  const envPath = join(projectDir, 'rayfin', '.env');
  expect(existsSync(envPath)).toBe(true);

  const envVars = parseRayfinEnvVars(projectDir);
  expect(envVars.get('RAYFIN_PUBLIC_API_URL')).toBeTruthy();
  expect(envVars.get('RAYFIN_PUBLIC_ITEM_ID')).toBeTruthy();
  expect(envVars.get('RAYFIN_PUBLIC_WORKSPACE_ID')).toBeTruthy();
  expect(envVars.get('RAYFIN_PUBLIC_PUBLISHABLE_KEY')).toBeTruthy();

  // Cross-validate .env values match .deployments.json
  expect(envVars.get('RAYFIN_PUBLIC_ITEM_ID')).toBe(deployment.fabricItemId);
  expect(envVars.get('RAYFIN_PUBLIC_WORKSPACE_ID')).toBe(
    deployment.fabricWorkspaceId
  );
  expect(envVars.get('RAYFIN_PUBLIC_API_URL')).toBe(deployment.fabricApiUrl);

  // Validate API URL contains workspace and item IDs
  const apiUrl = deployment.fabricApiUrl as string;
  expect(apiUrl).toContain(deployment.fabricWorkspaceId);
  expect(apiUrl).toContain(deployment.fabricItemId);
});

test('hostingUrl is reachable in the browser without errors', async ({
  page,
}) => {
  test.skip(!shouldRun, 'Skipped: Fabric E2E env vars not configured');

  const consoleErrors: string[] = [];

  // Collect console errors during navigation
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  const response = await navigateToReachableHostingUrl(page, hostingUrl, () => {
    consoleErrors.length = 0;
  });

  // The endpoint should be reachable (not a 5xx server error)
  expect(response).not.toBeNull();
  const status = response!.status();
  expect(status, `Expected non-5xx response but got ${status}`).toBeLessThan(
    500
  );

  // Filter out benign resource-loading 404s (favicon, static assets) that are
  // expected when navigating to an API endpoint rather than a full web app.
  const significantErrors = consoleErrors.filter(
    (msg) => !msg.match(/Failed to load resource:.*\b(404|403)\b/)
  );

  expect(
    significantErrors,
    `Unexpected console errors:\n${significantErrors.join('\n')}`
  ).toHaveLength(0);
});

test.skip('sign in with Microsoft completes authentication', async ({
  page,
}) => {
  test.skip(!shouldRun, 'Skipped: Fabric E2E env vars not configured');

  await navigateToReachableHostingUrl(page, hostingUrl);

  // Click "Sign in with Microsoft" and wait for the auth popup
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');

  // Wait for the email input to be visible and focused
  // Prod uses input[type="text"]#email; other environments use input[type="email"]
  const emailInput = popup.locator('input[type="email"], input#email');
  await emailInput.waitFor({ state: 'visible', timeout: 10_000 });
  await emailInput.fill(
    'AppDevDailyTestUser@fabricappdev20260410.onmicrosoft.com'
  );
  await popup.keyboard.press('Enter');

  // Certificate selection is handled automatically by Playwright's
  // clientCertificates config (TLS-level). In CI the cert is injected via
  // E2E_CERT_PATH; locally it falls back to the OS certificate store dialog.
  if (!process.env.E2E_CERT_PATH) {
    // Local only: wait for OS cert dialog and press Enter to select first cert.
    await new Promise((r) => setTimeout(r, 3_000));
    await popup.keyboard.press('Enter');
  }

  // "Stay signed in?" prompt — press Enter to confirm
  await new Promise((r) => setTimeout(r, 3_000));
  await popup.keyboard.press('Enter');

  // After authentication, the popup closes and we're back on the main page.
  // Wait for the page to settle after auth completes.
  await page.waitForTimeout(2_000);

  // Add a todo item
  const todoText = 'Teach a mass of penguins to do the macarena';
  const todoInput = page.getByPlaceholder('What needs to be done?');
  await todoInput.waitFor({ state: 'visible', timeout: 50_000 });
  await todoInput.fill(todoText);
  await page.getByRole('button', { name: /add/i }).click();

  // Verify the todo item appears in the list
  await page.waitForTimeout(2_000);
  const todoItem = page.locator('li > span', { hasText: todoText });
  await expect(todoItem).toBeVisible();
});

// ─── dataapp template deploy + browser validation ─────────────────────────────

test.describe('dataapp deploy', () => {
  let dataappTempDir: string;
  let dataappProjectDir: string;
  let dataappHostingUrl: string;

  test.beforeAll(async () => {
    if (!shouldRun) return;

    console.log(
      `[fabric-deploy:dataapp] Using pre-created artifact: ${dataappArtifactName} (id=${dataappArtifactId}, workspace=${dataappWorkspaceId})`
    );

    const temp = createTempDir();
    dataappTempDir = temp.dir;

    const runners = { runCli, runCreateRayfin };
    const result = await loginScaffoldAndDeploy({
      config: {
        ...config,
        artifactName: dataappArtifactName,
        artifactId: dataappArtifactId,
        workspaceId: dataappWorkspaceId,
      },
      tempDir: dataappTempDir,
      template: 'dataapp',
      dialect: 'mssql',
      beforeDeploy: (projectDir) => {
        const rayfinYml = parse(
          readFileSync(join(projectDir, 'rayfin', 'rayfin.yml'), 'utf8')
        ) as {
          services?: { staticHosting?: { assetAccess?: unknown } };
        };
        expect(rayfinYml.services?.staticHosting?.assetAccess).toBeUndefined();
      },
      runners,
    });
    dataappProjectDir = result.projectDir;

    // Extract hostingUrl from .deployments.json
    const { deployment } = parseDeploymentsRegistry(dataappProjectDir);
    expect(deployment.hostingUrl).toBeTruthy();

    const deployedRayfinYml = parse(
      readFileSync(join(dataappProjectDir, 'rayfin', 'rayfin.yml'), 'utf8')
    ) as { services?: { staticHosting?: { assetAccess?: unknown } } };
    expect(deployedRayfinYml.services?.staticHosting?.assetAccess).toBe(
      'protected'
    );

    dataappHostingUrl = deployment.hostingUrl as string;
  });

  test.afterAll(async () => {
    if (dataappTempDir && existsSync(dataappTempDir)) {
      rmSync(dataappTempDir, { recursive: true, force: true });
    }
  });

  test('dataapp hostingUrl is reachable in the browser without errors', async ({
    page,
  }) => {
    test.skip(!shouldRun, 'Skipped: Fabric E2E env vars not configured');

    const consoleErrors: string[] = [];

    // Collect console errors during navigation
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Collect uncaught page errors
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    const response = await navigateToReachableHostingUrl(
      page,
      dataappHostingUrl,
      () => {
        consoleErrors.length = 0;
        pageErrors.length = 0;
      }
    );

    // The hosting URL should be reachable regardless of tenant enforcement state.
    expect(response).not.toBeNull();
    const status = response!.status();
    expect(status, `Expected non-5xx response but got ${status}`).toBeLessThan(
      500
    );

    // Wait for any async initialization errors to surface
    await page.waitForTimeout(2_000);

    // Filter out benign resource-loading 404s (favicon, static assets)
    const significantErrors = consoleErrors.filter(
      (msg) => !msg.match(/Failed to load resource:.*\b(404|403)\b/)
    );

    expect(
      significantErrors,
      [
        'The dataapp template produced console errors after deployment.',
        'This may indicate missing or incorrectly named environment variables',
        '(e.g. "RayfinClient requires VITE_RAYFIN_BASE_URL...").',
        '',
        `Console errors:\n${significantErrors.join('\n')}`,
      ].join('\n')
    ).toHaveLength(0);

    expect(
      pageErrors,
      [
        'The dataapp template threw uncaught errors after deployment.',
        'This may indicate the app crashes at startup due to missing config.',
        '',
        `Page errors:\n${pageErrors.join('\n')}`,
      ].join('\n')
    ).toHaveLength(0);
  });
});
