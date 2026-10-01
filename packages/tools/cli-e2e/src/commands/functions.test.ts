import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type FabricE2EConfig, loadFabricE2EConfig } from '../helpers/env.js';
import {
  createTestArtifact,
  deleteTestArtifact,
  getFabricAccessToken,
} from '../helpers/fabric-api.js';
import { initFunctions } from '../helpers/init-functions.js';
import type { CliResult } from '../helpers/local-packages.js';
import { createTempDir, readRayfinYml, runCli } from '../helpers/run-cli.js';
import {
  loginScaffoldAndDeploy,
  parseDeploymentsRegistry,
  runRegistryDependent,
} from '../helpers/scaffold-template.js';

interface InvocationConfig {
  baseUrl: string;
  publishableKey: string;
  accessToken: string;
}

interface InvocationEnvelope {
  status?: string;
  output?: unknown;
  errors?: unknown[];
}

interface SecretState {
  present: boolean;
  length: number;
}

let invocationConfig: InvocationConfig | undefined;

function unwrapInvocationOutput(output: unknown): unknown {
  let current = output;
  for (let depth = 0; depth < 2 && typeof current === 'string'; depth++) {
    try {
      current = JSON.parse(current);
    } catch {
      return current;
    }
  }

  if (current && typeof current === 'object' && 'output' in current) {
    return (current as { output: unknown }).output;
  }
  return current;
}

async function invokeFunction(
  functionName: string,
  parameters: Record<string, unknown> = {}
): Promise<unknown> {
  if (!invocationConfig) {
    const config = loadFabricE2EConfig();
    const { deployment } = parseDeploymentsRegistry(projectDir);
    const baseUrl = deployment.fabricApiUrl;
    const publishableKey = deployment.publishableKey;
    if (typeof baseUrl !== 'string' || typeof publishableKey !== 'string') {
      throw new Error(
        'Active deployment is missing fabricApiUrl or publishableKey'
      );
    }

    invocationConfig = {
      baseUrl: baseUrl.replace(/\/$/u, ''),
      publishableKey,
      accessToken: await getFabricAccessToken(config),
    };
  }

  const response = await fetch(
    `${invocationConfig.baseUrl}/functions/${encodeURIComponent(functionName)}/invoke`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${invocationConfig.accessToken}`,
        'Content-Type': 'application/json',
        'X-Publishable-Key': invocationConfig.publishableKey,
        'x-ms-workload-resource-moniker': artifactId,
      },
      body: JSON.stringify(parameters),
    }
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Function invocation failed (HTTP ${response.status}): ${responseText}`
    );
  }

  const envelope = JSON.parse(responseText) as InvocationEnvelope;
  if (
    !['success', 'succeeded'].includes(envelope.status?.toLowerCase() ?? '')
  ) {
    throw new Error(
      `Function invocation returned status '${envelope.status ?? 'missing'}'`
    );
  }
  if (envelope.errors && envelope.errors.length > 0) {
    throw new Error('Function invocation returned runtime errors');
  }

  return unwrapInvocationOutput(envelope.output);
}

async function expectFunctionOutput(
  functionName: string,
  parameters: Record<string, unknown>,
  expected: unknown
): Promise<void> {
  let output: unknown;
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      output = await invokeFunction(functionName, parameters);
      if (JSON.stringify(output) === JSON.stringify(expected)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  if (lastError && output === undefined) {
    throw lastError;
  }
  expect(output).toEqual(expected);
}

// ─── File-level artifact lifecycle ────────────────────────────────────────────

let artifactId: string;
let artifactName: string;
let workspaceId: string;

beforeAll(async () => {
  if (!runRegistryDependent) return;

  const config = loadFabricE2EConfig();
  const result = await createTestArtifact({
    environment: config.environment,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tenantId: config.tenantId,
    workspaceName: config.workspaceName,
    tag: 'fn',
  });

  artifactId = result.artifactId;
  artifactName = result.artifactName;
  workspaceId = result.workspaceId;
}, 120_000);

afterAll(async () => {
  if (!artifactId || !workspaceId) return;

  const config = loadFabricE2EConfig();
  try {
    await deleteTestArtifact({
      environment: config.environment,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tenantId: config.tenantId,
      workspaceId,
      artifactId,
    });
  } catch (error) {
    console.error(`[functions-e2e] Failed to delete artifact: ${error}`);
  }
}, 60_000);

// ─── Shared project: scaffolded, deployed, then functions-initialised ─────────

/**
 * `rayfin functions init` installs and builds the functions package, and
 * `up functions deploy` needs a deployed item, so the suite sets both up once
 * and shares the project directory across tests.
 */
let projectDir: string;
let functionsInitResult: CliResult;
let cleanup: (() => void) | undefined;

describe(
  'rayfin functions — scaffold, typegen, and deploy',
  { timeout: 600_000 },
  () => {
    let config: FabricE2EConfig;

    beforeAll(async () => {
      if (!runRegistryDependent) return;

      config = loadFabricE2EConfig();

      const { dir: tempDir, cleanup: tempCleanup } = createTempDir(
        'rayfin-e2e-functions-'
      );
      cleanup = tempCleanup;

      const result = await loginScaffoldAndDeploy({
        config: { ...config, artifactName, artifactId, workspaceId },
        tempDir,
        template: 'todoapp',
      });
      projectDir = result.projectDir;

      // Scaffolds rayfin/functions/, installs deps, builds, and runs typegen.
      functionsInitResult = await initFunctions({ projectDir });
    }, 900_000);

    afterAll(() => {
      cleanup?.();
    });

    it.skipIf(!runRegistryDependent)(
      'scaffolds a functions project and enables functions in rayfin.yml',
      () => {
        expect(
          functionsInitResult.exitCode,
          `functions init failed:\n${functionsInitResult.output}`
        ).toBe(0);

        const functionsDir = join(projectDir, 'rayfin', 'functions');
        for (const relativePath of [
          'package.json',
          'tsconfig.json',
          'host.json',
          'local.settings.json',
          '.gitignore',
          join('src', 'function_app.ts'),
          join('src', 'types.ts'),
        ]) {
          expect(
            existsSync(join(functionsDir, relativePath)),
            `missing scaffolded file: rayfin/functions/${relativePath}`
          ).toBe(true);
        }

        const yml = readRayfinYml(projectDir) as {
          services?: {
            functions?: { enabled?: boolean; buildCommand?: string };
          };
        };
        expect(yml.services?.functions?.enabled).toBe(true);
        expect(yml.services?.functions?.buildCommand).toBe('npm run build');
      }
    );

    it.skipIf(!runRegistryDependent)(
      'regenerates types.ts from the functions source',
      async () => {
        const functionsSrc = join(projectDir, 'rayfin', 'functions', 'src');
        const typesPath = join(functionsSrc, 'types.ts');
        expect(
          existsSync(typesPath),
          `types.ts was not generated:\n${functionsInitResult.output}`
        ).toBe(true);

        // The scaffolded types.ts is copied from a template that already
        // names the seeded `helloWorld` function, so asserting on it proves
        // nothing about typegen. Register a uniquely named function and
        // re-run init — which preserves source and re-runs typegen — so the
        // assertion fails if generation regresses or becomes a no-op.
        const appPath = join(functionsSrc, 'function_app.ts');
        writeFileSync(
          appPath,
          `${readFileSync(appPath, 'utf8')}\n` +
            "udf.func('e2eTypegenProbe', (probeValue: string): number => probeValue.length, []);\n",
          'utf8'
        );

        const regenResult = await runCli(['functions', 'init'], {
          cwd: projectDir,
          timeoutMs: 300_000,
        });
        expect(
          regenResult.exitCode,
          `functions init re-run failed:\n${regenResult.output}`
        ).toBe(0);

        const types = readFileSync(typesPath, 'utf8');
        expect(types).toContain('AppFunctionsSchema');
        expect(types).toContain('e2eTypegenProbe');
        expect(types).toContain('probeValue');
      }
    );

    it.skipIf(!runRegistryDependent)(
      'deploys functions to the remote Rayfin item',
      async () => {
        const appPath = join(
          projectDir,
          'rayfin',
          'functions',
          'src',
          'function_app.ts'
        );
        const source = readFileSync(appPath, 'utf8').replace(
          "import { UserDataFunctions } from '@microsoft/fabric-user-data-functions';",
          "import { RayfinContext, UserDataFunctions } from '@microsoft/fabric-user-data-functions';"
        );
        writeFileSync(
          appPath,
          `${source}\n` +
            "udf.func('e2eSecretProbe', (ctx: RayfinContext): { present: boolean; length: number } => {\n" +
            "  const value = ctx.getSecret('E2E_FUNCTION_SECRET');\n" +
            '  return { present: value !== undefined, length: value?.length ?? 0 };\n' +
            '}, []);\n',
          'utf8'
        );

        const buildResult = await runCli(['functions', 'init'], {
          cwd: projectDir,
          timeoutMs: 300_000,
        });
        expect(
          buildResult.exitCode,
          `functions build failed:\n${buildResult.output}`
        ).toBe(0);

        const deployResult = await runCli(
          ['up', 'functions', 'deploy', '--verbose'],
          { cwd: projectDir, timeoutMs: 300_000 }
        );

        expect(
          deployResult.exitCode,
          `up functions deploy failed:\n${deployResult.output}`
        ).toBe(0);

        // The command polls until the deployment reaches a terminal state and
        // throws on failure, so this line only appears once the service
        // reports the deployment complete.
        expect(
          deployResult.output,
          `deploy exited 0 without reporting completion:\n${deployResult.output}`
        ).toMatch(/Functions deployed/u);

        await expectFunctionOutput(
          'helloWorld',
          { firstName: 'Ada', lastName: 'Lovelace' },
          'Hello Ada Lovelace!'
        );
      }
    );

    it.skipIf(!runRegistryDependent)(
      'makes set, rotated, and deleted secrets visible to deployed functions',
      async () => {
        const secretName = 'E2E_FUNCTION_SECRET';
        const initialValue = 'runtime-secret-v1';
        const rotatedValue = 'runtime-secret-value-v2';

        for (const value of [initialValue, rotatedValue]) {
          const setResult = await runCli(
            ['secret', 'set', secretName, '--stdin'],
            { cwd: projectDir, input: value }
          );
          expect(
            setResult.output.includes(value),
            'secret set exposed a stored secret value'
          ).toBe(false);
          expect(
            setResult.exitCode,
            `secret set failed:\n${setResult.output}`
          ).toBe(0);

          await expectFunctionOutput('e2eSecretProbe', {}, {
            present: true,
            length: value.length,
          } satisfies SecretState);
        }

        const deleteResult = await runCli(
          ['secret', 'delete', secretName, '--yes'],
          { cwd: projectDir }
        );
        expect(
          deleteResult.exitCode,
          `secret delete failed:\n${deleteResult.output}`
        ).toBe(0);

        await expectFunctionOutput('e2eSecretProbe', {}, {
          present: false,
          length: 0,
        } satisfies SecretState);
      }
    );
  }
);
