import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type E2EConfig, authMode, loadE2EConfig } from '../helpers/env.js';
import { createTempDir, runCli } from '../helpers/run-cli.js';

describe('rayfin logout', () => {
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
    'should report not signed in after logout',
    async () => {
      ({ dir: tempDir, cleanup } = createTempDir());

      // Login
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

      // Logout
      await runCli(['logout'], {
        cwd: tempDir,
        env: { RAYFIN_CONFIG_DIR: join(tempDir, '.rayfin') },
      });

      // Check status — should no longer be signed in
      const status = await runCli(['login', 'status'], {
        cwd: tempDir,
        env: { RAYFIN_CONFIG_DIR: join(tempDir, '.rayfin') },
      });

      expect(status.output).toMatch(/not (signed|logged) in/i);
    }
  );

  it('should handle logout when not logged in', async () => {
    ({ dir: tempDir, cleanup } = createTempDir());

    const result = await runCli(['logout'], {
      cwd: tempDir,
      env: { RAYFIN_CONFIG_DIR: join(tempDir, '.rayfin') },
    });

    // Should exit cleanly even if not logged in
    expect(result.exitCode).toBe(0);
  });
});
