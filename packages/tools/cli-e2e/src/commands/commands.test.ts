import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type E2EConfig, loadE2EConfig } from '../helpers/env.js';
import { createTempDir, runCli } from '../helpers/run-cli.js';

describe('rayfin version', () => {
  beforeAll(() => {
    loadE2EConfig(); // validate env vars are set
  });

  it('should print the CLI version', async () => {
    const result = await runCli(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('rayfin init (SP-authenticated)', () => {
  let config: E2EConfig;
  let tempDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    config = loadE2EConfig();
  });

  afterEach(() => {
    cleanup?.();
  });

  // skipping this for now sicne its create command and scaffolds from pre-created App artifacts
  it.skip('should scaffold a project after SP login', async () => {
    ({ dir: tempDir, cleanup } = createTempDir());

    // Login with SP first
    const login = await runCli(
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
    expect(login.exitCode).toBe(0);

    // Init a new project
    const init = await runCli(
      ['init', '--name', 'e2e-test-project', '--template', 'blank'],
      { cwd: tempDir, timeoutMs: 120_000 }
    );

    expect(init.exitCode).toBe(0);
  });
});
