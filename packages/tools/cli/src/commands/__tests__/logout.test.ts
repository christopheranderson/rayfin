import { RAYFIN_ENV_CONFIG_VARS } from '@microsoft/rayfin-tools-common/_internal/auth';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logoutCommand } from '../../commands/logout.js';

vi.mock('../../auth/rayfin-auth.js', () => ({
  RayfinAuth: vi.fn().mockImplementation(() => ({
    isLoggedIn: vi.fn().mockResolvedValue(true),
    logout: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Derived from the single source of truth in @microsoft/rayfin-tools-common
// so this test stays in sync if the env-var set ever changes.
const HYDRATED_VARS = RAYFIN_ENV_CONFIG_VARS.map(({ envVar }) => envVar);

describe('logout command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('command structure', () => {
    it('should have correct command name and description', () => {
      expect(logoutCommand.name()).toBe('logout');
      expect(logoutCommand.description()).toBe(
        'Sign out and clear cached credentials'
      );
    });

    it('should have no required arguments', () => {
      const args = logoutCommand.registeredArguments;
      expect(args).toHaveLength(0);
    });

    it('should be addable to parent command', () => {
      const parent = new Command('rayfin');
      expect(() => parent.addCommand(logoutCommand)).not.toThrow();
    });
  });

  describe('environment config cleanup', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const k of HYDRATED_VARS) {
        savedEnv[k] = process.env[k];
      }
      // Ensure RAYFIN_TOKEN is not set, so the no-op short-circuit doesn't fire.
      delete process.env['RAYFIN_TOKEN'];
    });

    afterEach(() => {
      for (const k of HYDRATED_VARS) {
        if (savedEnv[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = savedEnv[k];
        }
      }
    });

    it('clears in-process RAYFIN_* env vars after a successful logout', async () => {
      for (const k of HYDRATED_VARS) {
        process.env[k] = 'hydrated-value';
      }

      const parent = new Command();
      parent.addCommand(logoutCommand);
      await parent.parseAsync(['logout'], { from: 'user' });

      for (const k of HYDRATED_VARS) {
        expect(process.env[k]).toBeUndefined();
      }
    });

    it('is a no-op when RAYFIN_TOKEN is set (does not clear hydrated vars)', async () => {
      process.env['RAYFIN_TOKEN'] = 'externally-supplied-token';
      for (const k of HYDRATED_VARS) {
        process.env[k] = 'hydrated-value';
      }

      const parent = new Command();
      parent.addCommand(logoutCommand);
      await parent.parseAsync(['logout'], { from: 'user' });

      // RAYFIN_TOKEN short-circuit fires before the cleanup; vars persist.
      for (const k of HYDRATED_VARS) {
        expect(process.env[k]).toBe('hydrated-value');
      }

      delete process.env['RAYFIN_TOKEN'];
    });
  });
});
