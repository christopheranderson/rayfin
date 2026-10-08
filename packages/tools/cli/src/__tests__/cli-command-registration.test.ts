import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('CLI command registration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Re-importing `../index.js` from scratch under `vi.resetModules()`
  // pulls in commander, MSAL, OpenTelemetry, dotenv, inquirer, ora,
  // figlet, archiver, and the whole subcommand tree — under
  // concurrent test load (full `vitest run`) the cold-start can exceed
  // the default 5s timeout on contested CPU. 30s accommodates the slowest
  // observed cold import and remains tight enough to catch a real hang.
  const REIMPORT_TIMEOUT_MS = 30_000;

  it(
    'registers dev command without preview flags',
    async () => {
      vi.doMock('../utils/feature-flags.js', () => ({
        createCliFeatureFlags: () => ({
          get: () => false,
        }),
      }));

      const { cli } = await import('../index.js');
      const commandNames = cli.commands.map((c: { name: () => string }) =>
        c.name()
      );
      expect(commandNames).toContain('dev');
    },
    REIMPORT_TIMEOUT_MS
  );

  it(
    'registers root secret and functions commands',
    async () => {
      vi.doMock('../utils/feature-flags.js', () => ({
        createCliFeatureFlags: () => ({
          get: () => false,
        }),
      }));

      const { cli } = await import('../index.js');
      const commandNames = cli.commands.map((c: { name: () => string }) =>
        c.name()
      );
      expect(commandNames).toContain('secret');
      expect(commandNames).toContain('functions');
    },
    REIMPORT_TIMEOUT_MS
  );

  it(
    'registers `up storage` subcommand when storage flag is active',
    async () => {
      vi.doMock('../utils/feature-flags.js', () => ({
        createCliFeatureFlags: () => ({
          get: (name: string) => name === 'storage',
        }),
      }));

      const { cli } = await import('../index.js');
      const upCmd = cli.commands.find(
        (c: { name: () => string }) => c.name() === 'up'
      );
      const upSubcommands = upCmd?.commands.map((c: { name: () => string }) =>
        c.name()
      ) as string[];
      expect(upSubcommands).toContain('storage');
    },
    REIMPORT_TIMEOUT_MS
  );

  it(
    'does not register `up storage` subcommand when storage flag is inactive',
    async () => {
      vi.doMock('../utils/feature-flags.js', () => ({
        createCliFeatureFlags: () => ({
          get: () => false,
        }),
      }));

      const { cli } = await import('../index.js');
      const upCmd = cli.commands.find(
        (c: { name: () => string }) => c.name() === 'up'
      );
      const upSubcommands = upCmd?.commands.map((c: { name: () => string }) =>
        c.name()
      ) as string[];
      expect(upSubcommands).not.toContain('storage');
    },
    REIMPORT_TIMEOUT_MS
  );

  it(
    'registers `connector` and `up connector` regardless of feature flags',
    async () => {
      vi.doMock('../utils/feature-flags.js', () => ({
        createCliFeatureFlags: () => ({
          get: () => false,
        }),
      }));

      const { cli } = await import('../index.js');
      const topLevel = cli.commands.map((c: { name: () => string }) =>
        c.name()
      ) as string[];
      expect(topLevel).toContain('connector');

      const upCmd = cli.commands.find(
        (c: { name: () => string }) => c.name() === 'up'
      );
      const upSubcommands = upCmd?.commands.map((c: { name: () => string }) =>
        c.name()
      ) as string[];
      expect(upSubcommands).toContain('connector');
    },
    REIMPORT_TIMEOUT_MS
  );
});
