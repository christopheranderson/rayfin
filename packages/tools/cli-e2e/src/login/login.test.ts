import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type E2EConfig, authMode, loadE2EConfig } from '../helpers/env.js';
import { createTempDir, runCli } from '../helpers/run-cli.js';

describe('rayfin login (service principal)', () => {
  let config: E2EConfig;
  let tempDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    config = loadE2EConfig();
  });

  afterEach(() => {
    cleanup?.();
  });

  it.skipIf(authMode === 'user')(
    'should authenticate with valid SP credentials',
    async () => {
      ({ dir: tempDir, cleanup } = createTempDir());

      const result = await runCli(
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
        { cwd: tempDir, env: { RAYFIN_CONFIG_DIR: join(tempDir, '.rayfin') } }
      );

      console.log('Login stdout:', result.stdout);
      console.log('Login stderr:', result.stderr);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Signed in as service principal');
      expect(result.output).toContain(config.clientId);
    }
  );

  it.skipIf(authMode === 'user')(
    'should report status after SP login',
    async () => {
      ({ dir: tempDir, cleanup } = createTempDir());

      // Login first
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
        { cwd: tempDir, env: { RAYFIN_CONFIG_DIR: join(tempDir, '.rayfin') } }
      );
      expect(login.exitCode).toBe(0);

      // Check status
      const status = await runCli(['login', 'status'], {
        cwd: tempDir,
        env: { RAYFIN_CONFIG_DIR: join(tempDir, '.rayfin') },
      });

      console.log('Login stdout:', status.stdout);
      console.log('Login stderr:', status.stderr);

      expect(status.exitCode).toBe(0);
      expect(status.output).toContain('Signed in');
      expect(status.output).toContain('Identity:  service_principal');
    }
  );

  it.skipIf(authMode === 'user')(
    'should fail with missing client secret',
    async () => {
      ({ dir: tempDir, cleanup } = createTempDir());

      const result = await runCli(
        [
          'login',
          '--service-principal',
          '--client-id',
          config.clientId,
          '--tenant',
          config.tenantId,
          '--encryption-fallback-enabled',
        ],
        { cwd: tempDir, env: { RAYFIN_CONFIG_DIR: join(tempDir, '.rayfin') } }
      );

      expect(result.exitCode).not.toBe(0);
    }
  );

  it.skipIf(authMode === 'user')(
    'should fail with missing tenant',
    async () => {
      ({ dir: tempDir, cleanup } = createTempDir());

      const result = await runCli(
        [
          'login',
          '--service-principal',
          '--client-id',
          config.clientId,
          '--client-secret',
          config.clientSecret,
          '--encryption-fallback-enabled',
        ],
        { cwd: tempDir, env: { RAYFIN_CONFIG_DIR: join(tempDir, '.rayfin') } }
      );

      expect(result.exitCode).not.toBe(0);
    }
  );
});

describe('rayfin login (user credentials)', () => {
  it.skipIf(authMode === 'sp')(
    'should report signed-in status from prior interactive login',
    async () => {
      const result = await runCli(['login', 'status']);

      console.log('Login status stdout:', result.stdout);
      console.log('Login status stderr:', result.stderr);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Signed in');
      expect(result.output).toContain('Identity:  user');
    }
  );
});
