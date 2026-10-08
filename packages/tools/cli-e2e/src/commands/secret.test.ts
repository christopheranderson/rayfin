import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type FabricE2EConfig, loadFabricE2EConfig } from '../helpers/env.js';
import {
  createTestArtifact,
  deleteTestArtifact,
} from '../helpers/fabric-api.js';
import { createTempDir, readRayfinYml, runCli } from '../helpers/run-cli.js';
import {
  loginScaffoldAndDeploy,
  runRegistryDependent,
} from '../helpers/scaffold-template.js';

/**
 * Secret metadata as returned by `rayfin --json secret list`. Values are never
 * returned by the API, so these tests assert on names and timestamps only.
 */
interface SecretMetadata {
  name: string;
  createdAt: string;
  updatedAt: string;
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
    tag: 'sec',
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
    console.error(`[secret-e2e] Failed to delete artifact: ${error}`);
  }
}, 60_000);

// ─── Shared deploy: all secret tests reuse one deployed item ──────────────────

/**
 * `rayfin secret` resolves the workload endpoint from `rayfin/.deployments.json`,
 * so every test here needs a real deployed item. Deploying is the slow part, so
 * the suite deploys once and shares the project directory.
 */
let projectDir: string;
let cleanup: (() => void) | undefined;

/**
 * Secret management is gated per Fabric environment, and the endpoints 404
 * where it is off. Probe once after deploy so the suite skips with a clear
 * message rather than reporting an environment gap as a test failure, and
 * starts exercising the flow automatically once the feature is enabled.
 *
 * Only a 404 counts as "off" — any other failure fails the suite, so a real
 * regression cannot hide behind a skip.
 */
let secretsEnabled = false;

/**
 * Every value this suite stores.
 *
 * The API is not supposed to return a secret value under any circumstance, so
 * each one is checked against every later CLI response rather than asserted
 * once at a single call site — a leak then fails wherever it happens, not only
 * where someone thought to look.
 */
const storedValues = new Set<string>();

/**
 * `--json` must precede the subcommand: the flag is declared on the root command
 * and read via `resolveRootOutputFlags`. It is also required here because
 * `secret list` prints nothing in plain mode when stdin is not a TTY.
 */
async function listSecrets(): Promise<SecretMetadata[]> {
  const result = await runCli(['--json', 'secret', 'list'], {
    cwd: projectDir,
  });
  expect(result.exitCode, `secret list failed:\n${result.output}`).toBe(0);
  expectNoStoredValues(result.output, 'secret list');

  return (JSON.parse(result.stdout) as { secrets: SecretMetadata[] }).secrets;
}

/** Fails with the offending command rather than dumping the value into CI logs. */
function expectNoStoredValues(output: string, command: string): void {
  for (const value of storedValues) {
    expect(
      output.includes(value),
      `${command} exposed a stored secret value`
    ).toBe(false);
  }
}

async function listSecretNames(): Promise<string[]> {
  return (await listSecrets()).map((s) => s.name);
}

async function setSecret(name: string, value: string, description?: string) {
  const args = ['secret', 'set', name, '--stdin'];
  if (description !== undefined) {
    // The CLI rejects a bare `--describe` token; only the `=` form is accepted.
    args.push(`--describe=${description}`);
  }
  storedValues.add(value);
  const result = await runCli(args, { cwd: projectDir, input: value });
  expectNoStoredValues(result.output, 'secret set');

  return result;
}

describe(
  'rayfin secret — Fabric secret management',
  { timeout: 300_000 },
  () => {
    let config: FabricE2EConfig;

    beforeAll(async () => {
      if (!runRegistryDependent) return;

      config = loadFabricE2EConfig();

      const { dir: tempDir, cleanup: tempCleanup } =
        createTempDir('rayfin-e2e-secret-');
      cleanup = tempCleanup;

      const result = await loginScaffoldAndDeploy({
        config: { ...config, artifactName, artifactId, workspaceId },
        tempDir,
        template: 'todoapp',
      });
      projectDir = result.projectDir;

      const probe = await runCli(['--json', 'secret', 'list'], {
        cwd: projectDir,
      });
      secretsEnabled = probe.exitCode === 0;
      if (!secretsEnabled) {
        // Only a 404 means the feature is off. Skipping on anything else —
        // auth, network, a CLI regression — would hide a real failure behind
        // a message claiming the environment simply lacks the feature.
        if (!/\b404\b/u.test(probe.output)) {
          throw new Error(
            '[secret-e2e] `secret list` failed for a reason other than secret ' +
              `management being disabled:\n${probe.output}`
          );
        }
        console.warn(
          `[secret-e2e] Secret management is unavailable in this environment — skipping.\n${probe.output}`
        );
      }
    }, 600_000);

    afterAll(() => {
      cleanup?.();
    });

    it.skipIf(!runRegistryDependent)(
      'reuses the same entry when a secret name is set twice (metadata upsert)',
      async (ctx) => {
        if (!secretsEnabled) ctx.skip();

        const name = 'E2E_ROUNDTRIP_SECRET';

        const setResult = await setSecret(name, 'initial-value');
        expect(
          setResult.exitCode,
          `secret set failed:\n${setResult.output}`
        ).toBe(0);

        const created = (await listSecrets()).find((s) => s.name === name);
        expect(created, `"${name}" missing after set`).toBeDefined();

        const updateResult = await setSecret(name, 'rotated-value');
        expect(
          updateResult.exitCode,
          `secret set (update) failed:\n${updateResult.output}`
        ).toBe(0);

        // The API never returns secret values, so this asserts the metadata
        // contract only: one entry per name, carrying the original createdAt.
        const after = await listSecrets();
        expect(after.filter((s) => s.name === name)).toHaveLength(1);

        const updated = after.find((s) => s.name === name);
        expect(updated!.createdAt).toBe(created!.createdAt);
        expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
          new Date(created!.updatedAt).getTime()
        );
      }
    );

    it.skipIf(!runRegistryDependent)(
      'bulk applies secrets from a dotenv file',
      async (ctx) => {
        if (!secretsEnabled) ctx.skip();

        writeFileSync(
          join(projectDir, 'rayfin', '.env.secrets'),
          '# bulk apply fixture\nE2E_BULK_ONE=value-one\nE2E_BULK_TWO="value two"\n',
          'utf8'
        );

        const setResult = await runCli(
          ['secret', 'set', '--env-file', 'rayfin/.env.secrets'],
          { cwd: projectDir }
        );
        expect(
          setResult.exitCode,
          `bulk secret set failed:\n${setResult.output}`
        ).toBe(0);

        const names = await listSecretNames();
        expect(names).toContain('E2E_BULK_ONE');
        expect(names).toContain('E2E_BULK_TWO');
      }
    );

    it.skipIf(!runRegistryDependent)(
      'records secret metadata in rayfin.yml when --describe is passed',
      async (ctx) => {
        if (!secretsEnabled) ctx.skip();

        const name = 'E2E_DESCRIBED_SECRET';
        const description = 'Token used by the E2E suite';

        const setResult = await setSecret(name, 'described-value', description);
        expect(
          setResult.exitCode,
          `secret set --describe failed:\n${setResult.output}`
        ).toBe(0);

        const yml = readRayfinYml(projectDir) as {
          secrets?: Array<{ name: string; description?: string }>;
        };
        const entry = yml.secrets?.find((s) => s.name === name);
        expect(
          entry,
          `"${name}" missing from rayfin.yml secrets`
        ).toBeDefined();
        expect(entry!.description).toBe(description);
      }
    );

    it.skipIf(!runRegistryDependent)('deletes a secret', async (ctx) => {
      if (!secretsEnabled) ctx.skip();

      const name = 'E2E_DELETABLE_SECRET';

      const setResult = await setSecret(name, 'delete-me');
      expect(
        setResult.exitCode,
        `secret set failed:\n${setResult.output}`
      ).toBe(0);
      expect(await listSecretNames()).toContain(name);

      const deleteResult = await runCli(['secret', 'delete', name, '--yes'], {
        cwd: projectDir,
      });
      expect(
        deleteResult.exitCode,
        `secret delete failed:\n${deleteResult.output}`
      ).toBe(0);

      expect(await listSecretNames()).not.toContain(name);
    });
  }
);
