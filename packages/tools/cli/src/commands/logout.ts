import { RAYFIN_ENV_CONFIG_VARS } from '@microsoft/rayfin-tools-common/_internal/env-config';
import { Command } from 'commander';

import { CliHandledError } from '../errors.js';
import { hasAmbientToken } from '../utils/ambient-env.js';
import {
  emitJson,
  modeLog,
  modeError,
  resolveOutputMode,
  resolveRootOutputFlags,
} from '../utils/output-mode.js';

/**
 * `rayfin logout` — Clear cached credentials and auth state.
 *
 * Also clears the in-process `RAYFIN_*` env vars enumerated by
 * `RAYFIN_ENV_CONFIG_VARS` so any subsequent in-process
 * invocation (e.g. tests) sees the built-in defaults rather than stale
 * persisted values. Shell-exported `RAYFIN_*` vars are NOT affected —
 * `delete process.env.X` only removes the in-process copy; the next
 * `rayfin` invocation reads the user's shell again.
 */
export const logoutCommand = new Command('logout')
  .description('Sign out and clear cached credentials')
  .action(async (_options: unknown, command: Command) => {
    const mode = resolveOutputMode({
      json: resolveRootOutputFlags(command).json,
    });

    if (hasAmbientToken()) {
      modeLog(
        mode,
        'Authentication is managed externally via RAYFIN_TOKEN. Skipping logout.'
      );
      return;
    }

    try {
      // Dynamic import is intentional: lazy-loads native modules
      // (e.g. msal-node-extensions / keytar) to avoid requiring native
      // binaries at command-definition time.
      const { RayfinAuth } = await import('../auth/rayfin-auth.js');
      const auth = new RayfinAuth();

      const wasLoggedIn = await auth.isLoggedIn();
      await auth.logout();

      // Clear in-process RAYFIN_* env vars hydrated by bootstrap so the
      // next in-process command sees built-in defaults. Shell exports
      // are unaffected (the next process reads them again from the
      // user's shell). The persisted environmentConfig has already been
      // removed by clearAuthState() inside auth.logout().
      for (const { envVar } of RAYFIN_ENV_CONFIG_VARS) {
        delete process.env[envVar];
      }

      if (wasLoggedIn) {
        modeLog(
          mode,
          '✅ Signed out successfully. Cached credentials cleared.'
        );
      } else {
        modeLog(
          mode,
          'ℹ️  No active session found. Credentials already cleared.'
        );
      }

      // Emit a minimal completion envelope so `rayfin --json logout`
      // consumers always get something parseable on stdout rather than
      // empty silence. See PR #1215 review thread.
      if (mode === 'json') {
        emitJson({
          status: 'ok',
          command: 'logout',
          wasSignedIn: wasLoggedIn,
        });
      }
    } catch (error) {
      modeError(mode, `❌ Logout failed: ${(error as Error).message}`);
      throw new CliHandledError(error);
    }
  });
