/**
 * Vitest globalSetup for CLI E2E tests.
 *
 * When E2E_AUTH_MODE=user, ensures the user has a valid interactive login
 * session before any tests run. If no user session exists (or a service
 * principal session is cached), triggers `rayfin login --tenant <id>` which
 * opens the browser for interactive authentication.
 */
import { execFile as execFileCb } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadFabricE2EConfig } from './helpers/env.js';
import { cleanupStaleTestArtifacts } from './helpers/fabric-api.js';

const execFile = promisify(execFileCb);

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const RAYFIN_MAIN = join(REPO_ROOT, 'packages/tools/cli/scripts/main');

function resolveCliPath(): string {
  if (process.env['E2E_CLI_SOURCE'] === 'published') {
    return 'rayfin';
  }
  return RAYFIN_MAIN;
}

async function runCli(
  args: string[]
): Promise<{ exitCode: number; output: string }> {
  const cliPath = resolveCliPath();
  const isGlobal = cliPath === 'rayfin';
  const command = isGlobal ? 'rayfin' : process.execPath;
  const fullArgs = isGlobal ? args : [cliPath, ...args];

  try {
    const { stdout, stderr } = await execFile(command, fullArgs, {
      env: { ...process.env, RAYFIN_TELEMETRY_OPTOUT: '1' },
      timeout: 120_000,
    });
    return { exitCode: 0, output: stdout + stderr };
  } catch (err: any) {
    return {
      exitCode: err.code ?? 1,
      output: (err.stdout ?? '') + (err.stderr ?? ''),
    };
  }
}

export async function setup(): Promise<void> {
  const authMode = process.env['E2E_AUTH_MODE'] || 'sp';
  if (authMode === 'user') {
    const tenantId = process.env['E2E_TENANT_ID'];
    if (!tenantId) {
      throw new Error(
        'E2E_AUTH_MODE=user requires E2E_TENANT_ID to be set. ' +
          'Fill it in your .env file.'
      );
    }

    // Check if already signed in as a user.
    // Note: on Windows the process may crash during cleanup (libuv assertion)
    // even after producing valid output, so check output content not exit code.
    const status = await runCli(['login', 'status']);
    const isUserSession =
      status.output.includes('Signed in') &&
      status.output.includes('Identity:  user');

    if (isUserSession) {
      console.log('[e2e-setup] Already signed in as user — skipping login.');
    } else {
      // Not signed in as user — trigger interactive login
      console.log('[e2e-setup] Opening browser for interactive login...');
      console.log(
        '[e2e-setup] Please sign in with your account in the browser window.'
      );

      const loginArgs = ['login', '--tenant', tenantId];
      if (process.env['RAYFIN_ENCRYPTION_FALLBACK_ENABLED'] === 'true') {
        loginArgs.push('--encryption-fallback-enabled');
      }

      const login = await runCli(loginArgs);
      // On Windows, a libuv assertion can crash the process during cleanup even
      // after a successful login. Check output for the success message instead of
      // relying solely on exit code.
      const loginSucceeded = login.output.includes('Signed in successfully');
      if (!loginSucceeded) {
        throw new Error(
          `[e2e-setup] Interactive login failed:\n${login.output}\n\n` +
            'If the browser did not open, try running manually:\n' +
            `  rayfin login --tenant ${tenantId}`
        );
      }

      console.log('[e2e-setup] Login successful.');
    }
  }

  if (process.env['CI'] === 'true') {
    const config = loadFabricE2EConfig();
    await cleanupStaleTestArtifacts(config);
  }
}
