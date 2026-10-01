import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';

import {
  type FabricE2EConfig,
  authMode,
  loadFabricE2EConfig,
} from '../helpers/env.js';
import {
  createTestArtifact,
  deleteTestArtifact,
} from '../helpers/fabric-api.js';
import { writeTodoEntity } from '../helpers/local-packages.js';
import {
  createTempDir,
  readRayfinYml,
  runCli,
  runCreateRayfin,
} from '../helpers/run-cli.js';
import {
  loginScaffoldAndDeploy,
  parseDeploymentsRegistry,
  parseRayfinEnvVars,
  runRegistryDependent,
} from '../helpers/scaffold-template.js';

// ─── File-level artifact lifecycle ────────────────────────────────────────────

let artifactId: string;
let artifactName: string;
let workspaceId: string;

beforeAll(async () => {
  const config = loadFabricE2EConfig();
  console.log('[fabric-e2e] Creating test artifact...');

  const result = await createTestArtifact({
    environment: config.environment,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tenantId: config.tenantId,
    workspaceName: config.workspaceName,
    tag: 'fab',
  });

  artifactId = result.artifactId;
  artifactName = result.artifactName;
  workspaceId = result.workspaceId;

  console.log(
    `[fabric-e2e] Created artifact: ${artifactName} (id=${artifactId}, workspace=${workspaceId})`
  );
}, 120_000);

afterAll(async () => {
  if (!artifactId || !workspaceId) return;

  const config = loadFabricE2EConfig();
  console.log(`[fabric-e2e] Deleting test artifact: ${artifactName}...`);

  try {
    await deleteTestArtifact({
      environment: config.environment,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tenantId: config.tenantId,
      workspaceId,
      artifactId,
    });
    console.log(`[fabric-e2e] Deleted artifact: ${artifactName}`);
  } catch (error) {
    console.error(`[fabric-e2e] Failed to delete artifact: ${error}`);
  }
}, 60_000);

describe('create-rayfin — Fabric workspace scaffolding', () => {
  let config: FabricE2EConfig;
  let tempDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    config = loadFabricE2EConfig();
  });

  afterEach(() => {
    cleanup?.();
  });

  it('logs in with service principal and scaffolds a todoapp into a Fabric workspace', async () => {
    ({ dir: tempDir, cleanup } = createTempDir());

    if (authMode === 'user') {
      // User mode — verify existing login session
      const statusResult = await runCli(['login', 'status'], { cwd: tempDir });
      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.output).toContain('Signed in');
    } else {
      const loginResult = await runCli(
        [
          'login',
          '--service-principal',
          '--client-id',
          config.clientId,
          '--client-secret',
          config.clientSecret,
          '--tenant',
          config.tenantId,
          '--encryption-fallback-enabled',
        ],
        { cwd: tempDir }
      );
      expect(loginResult.exitCode).toBe(0);
    }

    const result = await runCreateRayfin(
      [
        artifactName,
        '--template',
        'todoapp',
        '--workspace',
        config.workspaceName,
        '--base-api-url',
        config.baseApiUrl,
        '--skip-install',
      ],
      { cwd: tempDir }
    );

    console.log('Login stdout:', result.stdout);
    console.log('Login stderr:', result.stderr);

    expect(result.exitCode).toBe(0);

    const projectDir = join(tempDir, artifactName);
    expect(existsSync(projectDir)).toBe(true);

    // rayfin.yml should have been generated
    const rayfinConfig = readRayfinYml(projectDir);
    expect(rayfinConfig['id']).toBeDefined();
    expect(rayfinConfig['name']).toBeDefined();

    // Fabric env overrides should be persisted
    const envPath = join(projectDir, 'rayfin', '.env');
    expect(existsSync(envPath)).toBe(true);
  });
});

// ─── Shared deploy: validation tests reuse a single deployment ────────────────

/**
 * All tests in this suite operate on the same scaffolded todoapp project
 * deployed via `rayfin up`. The deployment is done once in the model
 * modification suite above; this suite reuses that deployment's project dir.
 */
let sharedProjectDir: string;
let sharedCleanup: (() => void) | undefined;

describe(
  'create-rayfin — Fabric scaffold with model modification and validation',
  { timeout: 300_000 },
  () => {
    let config: FabricE2EConfig;

    beforeAll(async () => {
      if (!runRegistryDependent) return;

      config = loadFabricE2EConfig();

      const { dir: tempDir, cleanup } = createTempDir();
      sharedCleanup = cleanup;

      const result = await loginScaffoldAndDeploy({
        config: { ...config, artifactName, artifactId, workspaceId },
        tempDir,
        template: 'todoapp',
      });
      sharedProjectDir = result.projectDir;
      // Budget covers login + scaffold (120s) + a cold-cache npm install (300s)
      // + `rayfin up` (120s). This is the first install of a CI run, so it pays
      // the full dependency download.
    }, 600_000);

    afterAll(() => {
      sharedCleanup?.();
    });

    it.skipIf(!runRegistryDependent)(
      'scaffolds a todoapp, modifies the model, and deploys with rayfin up',
      async () => {
        // The model modification test reuses the already-deployed project
        // by modifying its data model and re-running rayfin up.
        const todoPath = join(sharedProjectDir, 'rayfin', 'data', 'Todo.ts');
        expect(existsSync(todoPath)).toBe(true);

        unlinkSync(todoPath);
        writeTodoEntity(sharedProjectDir);

        // Run rayfin up to deploy the updated config
        const upResult = await runCli(['up', '-y', '--verbose'], {
          cwd: sharedProjectDir,
          timeoutMs: 120_000,
        });

        console.log('Up stdout:', upResult.stdout);
        console.log('Up stderr:', upResult.stderr);

        expect(upResult.exitCode, `rayfin up failed:\n${upResult.output}`).toBe(
          0
        );
      }
    );

    it.skipIf(!runRegistryDependent)(
      'validates deployment env outputs',
      async () => {
        const config = loadFabricE2EConfig();

        // Validate rayfin/.deployments.json
        const { active: activeName, deployment } =
          parseDeploymentsRegistry(sharedProjectDir);
        expect(activeName).toBe(
          config.workspaceName
            .toLowerCase()
            .replace(/[\s_]+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-{2,}/g, '-')
            .replace(/^-+|-+$/g, '')
        );

        expect(deployment).toBeDefined();
        expect(deployment.fabricItemId).toEqual(expect.any(String));
        expect((deployment.fabricItemId as string).length).toBeGreaterThan(0);
        expect(deployment.fabricApiUrl).toEqual(expect.any(String));
        expect((deployment.fabricApiUrl as string).length).toBeGreaterThan(0);
        expect(deployment.fabricWorkspaceId).toEqual(expect.any(String));
        expect((deployment.fabricWorkspaceId as string).length).toBeGreaterThan(
          0
        );
        expect(deployment.deployedAt).toEqual(expect.any(String));
        expect(new Date(deployment.deployedAt as string).toISOString()).toBe(
          deployment.deployedAt
        );
        expect(deployment.publishableKey).toBeDefined();

        // Validate RAYFIN_PUBLIC_* values in rayfin/.env
        const envPath = join(sharedProjectDir, 'rayfin', '.env');
        expect(existsSync(envPath)).toBe(true);

        const envContent = readFileSync(envPath, 'utf8');
        expect(envContent).toMatch(/^RAYFIN_PUBLIC_API_URL=.+$/m);
        expect(envContent).toMatch(/^RAYFIN_PUBLIC_ITEM_ID=.+$/m);
        expect(envContent).toMatch(/^RAYFIN_PUBLIC_WORKSPACE_ID=.+$/m);
        expect(envContent).toMatch(/^RAYFIN_PUBLIC_PUBLISHABLE_KEY=.+$/m);

        // Cross-validate .env values match .deployments.json
        const envVars = parseRayfinEnvVars(sharedProjectDir);

        expect(envVars.get('RAYFIN_PUBLIC_ITEM_ID')).toBe(
          deployment.fabricItemId
        );
        expect(envVars.get('RAYFIN_PUBLIC_WORKSPACE_ID')).toBe(
          deployment.fabricWorkspaceId
        );
        expect(envVars.get('RAYFIN_PUBLIC_API_URL')).toBe(
          deployment.fabricApiUrl
        );

        // Validate API URL contains workspace and item IDs
        const apiUrl = deployment.fabricApiUrl as string;
        expect(apiUrl).toContain(deployment.fabricWorkspaceId);
        expect(apiUrl).toContain(deployment.fabricItemId);
      }
    );

    it.skipIf(!runRegistryDependent)(
      'rayfin up list returns the active deployment in JSON format',
      async () => {
        const listResult = await runCli(['up', 'list', '--json'], {
          cwd: sharedProjectDir,
        });

        console.log('up list stdout:', listResult.stdout);
        console.log('up list stderr:', listResult.stderr);

        expect(
          listResult.exitCode,
          `rayfin up list failed:\n${listResult.output}`
        ).toBe(0);

        const deployments = JSON.parse(listResult.stdout);
        expect(Array.isArray(deployments)).toBe(true);
        expect(deployments.length).toBeGreaterThanOrEqual(1);

        const active = deployments.find(
          (d: { active: boolean }) => d.active === true
        );
        expect(active).toBeDefined();
        expect(active.workspaceName).toEqual(expect.any(String));
        expect(active.itemId).toEqual(expect.any(String));
        expect(active.itemId.length).toBeGreaterThan(0);
        expect(active.apiUrl).toEqual(expect.any(String));
        expect(active.apiUrl.length).toBeGreaterThan(0);
        expect(active.workspaceId).toEqual(expect.any(String));
        expect(active.workspaceId.length).toBeGreaterThan(0);
        expect(active.deployedAt).toEqual(expect.any(String));
      }
    );

    it.skipIf(!runRegistryDependent)(
      'rayfin up status reports a healthy deployment in JSON format',
      async () => {
        const statusResult = await runCli(['up', 'status', '--json'], {
          cwd: sharedProjectDir,
          timeoutMs: 120_000,
        });

        console.log('up status stdout:', statusResult.stdout);
        console.log('up status stderr:', statusResult.stderr);

        expect(
          statusResult.exitCode,
          `rayfin up status failed:\n${statusResult.output}`
        ).toBe(0);

        const status = JSON.parse(statusResult.stdout);
        expect(status.deployed).toBe(true);
        expect(status.projectName).toEqual(expect.any(String));
        expect(status.deployment).toBeDefined();
        expect(status.deployment.rayfinItemId).toEqual(expect.any(String));
        expect(status.deployment.rayfinItemId.length).toBeGreaterThan(0);
        expect(status.deployment.rayfinApiUrl).toEqual(expect.any(String));
        expect(status.deployment.fabricWorkspaceId).toEqual(expect.any(String));
        expect(status.deployment.publishableKey).toBeDefined();
        const { deployment } = parseDeploymentsRegistry(sharedProjectDir);
        expect(deployment.hostingUrl).toEqual(expect.any(String));
        expect(status.deployment.hostingUrl).toBe(deployment.hostingUrl);
        expect(status.endpointHealth).toBeDefined();
        expect(status.endpointHealth.reachable).toBe(true);
      },
      180_000
    );
  }
);
