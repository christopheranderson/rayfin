import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import type { RayfinClient } from '@microsoft/rayfin-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';
import {
  forceRestartBackend,
  getBackendUrl,
  startBackend,
  stopBackend,
} from '../../shared/backend';
import { createTestClient } from '../../shared/client-factory';
import { generateUniqueUser } from '../../shared/test-data';
import { getDialect } from '../query-builder/setup';

const RAYFIN_PUBLISHABLE_KEY = 'pk-commonSampleAppPKkey';
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const RAYFIN_YML_PATH = resolve(__dirname, '../../../rayfin/rayfin.yml');

describe('Data Initialization Validation', () => {
  let client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;

  // Snapshot of rayfin.yml taken before any test modifies it.
  // Restored in afterAll so the file is always reverted even if a test times out.
  let originalYml: string | null = null;

  beforeAll(async () => {
    // Capture the original rayfin.yml before any tests run
    originalYml = readFileSync(RAYFIN_YML_PATH, 'utf-8');

    await startBackend();

    client = createTestClient();
    const user = generateUniqueUser();

    await client.auth.signUp({ email: user.email, password: user.password });
    await client.auth.signIn({ email: user.email, password: user.password });
  });

  afterAll(async () => {
    // Always restore the original rayfin.yml regardless of test outcome.
    // This runs even when a test times out (unlike try/finally inside the test).
    if (originalYml !== null) {
      writeFileSync(RAYFIN_YML_PATH, originalYml, 'utf-8');
    }

    await stopBackend();
  });

  it('should have the correct database container running', () => {
    const dialect = getDialect();

    // Get running Docker containers
    const output = execSync('docker ps --format "{{.Names}}"', {
      encoding: 'utf-8',
    });
    const runningContainers = output
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);

    if (dialect === 'postgresql') {
      const pgContainer = runningContainers.find((name) =>
        name.includes('postgres-dataapi')
      );
      expect(pgContainer).toBeDefined();
    } else {
      const sqlContainer = runningContainers.find((name) =>
        name.includes('sqlserver')
      );
      expect(sqlContainer).toBeDefined();
    }
  });

  it('should return the correct project runtime settings with data enabled', async () => {
    const baseUrl = getBackendUrl();
    const dialect = getDialect();
    const response = await fetch(`${baseUrl}/api/projectRuntimeSettings`, {
      headers: { 'x-rayfin-publishable-key': RAYFIN_PUBLISHABLE_KEY },
    });

    expect(response.ok).toBe(true);

    const settings = await response.json();

    // Verify data service reports the correct dialect
    expect(settings.serviceSettings.data.enabled).toBe(true);
    expect(settings.serviceSettings.data.dialect).toBe(dialect);

    // Verify userDbInfo has the correct dbType and endpoint hostname
    const userDbInfo = settings.userDbInfo;
    expect(userDbInfo).toBeDefined();

    if (dialect === 'postgresql') {
      expect(userDbInfo.dbType).toBe('postgresql');
      expect(userDbInfo.endpointInformation).toContain('postgres-dataapi');
    } else {
      expect(userDbInfo.dbType).toBe('mssql');
      expect(userDbInfo.endpointInformation).toContain('sqlserver');
    }

    // Verify activeDataApiSchemaVersion exists
    expect(settings.activeDataApiSchemaVersion).toBeDefined();
    expect(typeof settings.activeDataApiSchemaVersion).toBe('number');
  });

  it('should reflect data as disabled when rayfin.yml has data disabled', async () => {
    // Modify rayfin.yml: disable data and remove dialect
    const disabledYml = originalYml!.replace(
      /data:\s*\n\s*enabled:\s*true\n\s*dialect:\s*\w+/,
      'data:\n    enabled: false'
    );
    writeFileSync(RAYFIN_YML_PATH, disabledYml, 'utf-8');

    // Cold-restart the backend with the modified config.
    //
    // We deliberately use `forceRestartBackend` (purge + cold start) instead
    // of a hot-swap (`startBackend({ skipRunningCheck: true })`). Hot-swapping
    // relies on `rayfin dev` recreating only the webservice container against
    // pre-existing state, which is flaky in CI: the recreated container can
    // end up Started-but-unreachable, blowing the apply-settings retry budget
    // before vitest's per-test timeout fires. A purge-then-cold-start matches
    // the realistic "user changed yml, restarted dev" workflow and reliably
    // settles in well under the timeout.
    //
    // Since data is disabled, wait for the workflow's runtime-start marker,
    // which occurs after settings and declared state are applied.
    await forceRestartBackend({
      readyMessage: 'Starting frontend dev server',
      reuseExistingImages: true,
    });

    // Verify the settings now report data as disabled
    const response = await fetch(
      `${getBackendUrl()}/api/projectRuntimeSettings`,
      {
        headers: { 'x-rayfin-publishable-key': RAYFIN_PUBLISHABLE_KEY },
      }
    );

    expect(response.ok).toBe(true);
    const settings = await response.json();
    expect(settings.serviceSettings.data.enabled).toBe(false);

    // Verify that the data configuration endpoint returns 404 when data is disabled.
    // The DataConfigurationController is guarded by [RequireServiceEnabled(ServiceType.Data)]
    const applyConfigResponse = await fetch(
      `${getBackendUrl()}/api/applyconfig`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    );

    expect(applyConfigResponse.status).toBe(404);
  }, 300000);

  it('should re-enable data and restart backend with the correct dialect', async () => {
    // Restore original rayfin.yml (data enabled with correct dialect)
    writeFileSync(RAYFIN_YML_PATH, originalYml!, 'utf-8');

    // Cold-restart for the same reason as the previous test: avoid the flaky
    // hot-swap recreate path; exercise the realistic "yml changed, restart
    // dev" workflow.
    await forceRestartBackend({ reuseExistingImages: true });

    const dialect = getDialect();

    // Verify runtime settings report data as enabled with the correct dialect
    const response = await fetch(
      `${getBackendUrl()}/api/projectRuntimeSettings`,
      {
        headers: { 'x-rayfin-publishable-key': RAYFIN_PUBLISHABLE_KEY },
      }
    );

    expect(response.ok).toBe(true);
    const settings = await response.json();
    expect(settings.serviceSettings.data.enabled).toBe(true);
    expect(settings.serviceSettings.data.dialect).toBe(dialect);
  }, 300000);
});
