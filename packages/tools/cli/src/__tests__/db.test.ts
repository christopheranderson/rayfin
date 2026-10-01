import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { dev } from '../commands/dev/dev';
import { upCommand } from '../commands/up/up';

/**
 * `dev` subcommands are feature-flag-gated since `docker-local-dev` and
 * `functions` ship as preview opt-ins. Tests assert on the *fully
 * enabled* structure, so we build a dev-command instance with both
 * flags explicitly turned on rather than reading from the bare
 * `devCommand` singleton (which inspects the test runner's CWD env and
 * registers no subcommands).
 */
function buildDevCommandWithFlags(): Command {
  return dev(process.cwd(), {
    processEnv: {
      ...process.env,
      RAYFIN_FEATURE_FLAGS: 'docker-local-dev,storage,functions',
    },
  });
}

describe('db commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let devCommand: Command;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    devCommand = buildDevCommandWithFlags();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('rayfin dev db', () => {
    let devDbCommand: Command;

    beforeEach(() => {
      devDbCommand = devCommand.commands.find((cmd) => cmd.name() === 'db')!;
    });

    it('should be registered under dev command', () => {
      expect(devDbCommand).toBeDefined();
      expect(devDbCommand.name()).toBe('db');
    });

    it('should have correct description', () => {
      expect(devDbCommand.description()).toBe(
        'Database operations for local development'
      );
    });

    it('should register just the apply subcommand', () => {
      const subcommands = devDbCommand.commands.map((cmd) => cmd.name());
      expect(subcommands).toContain('apply');
      expect(subcommands).toHaveLength(1);
    });

    describe('apply subcommand', () => {
      let applyCommand: Command;

      beforeEach(() => {
        applyCommand = devDbCommand.commands.find(
          (cmd) => cmd.name() === 'apply'
        )!;
      });

      it('should have correct name and description', () => {
        expect(applyCommand.name()).toBe('apply');
        expect(applyCommand.description()).toBe(
          'Generate and apply DAB configuration to local development server'
        );
      });

      it('should have --force option', () => {
        const options = applyCommand.options.map((opt) => opt.flags);
        expect(options).toContain('--force');
      });

      it('should have --gen-config-only option', () => {
        const options = applyCommand.options.map((opt) => opt.flags);
        expect(options).toContain('--gen-config-only');
      });

      it('should have --gen-config-only option with correct default', () => {
        const genConfigOnlyOption = applyCommand.options.find(
          (opt) => opt.long === '--gen-config-only'
        );
        expect(genConfigOnlyOption?.defaultValue).toBe(false);
      });

      it('should NOT have --remote option (local only)', () => {
        const options = applyCommand.options.map((opt) => opt.flags);
        expect(options).not.toContain('--remote');
      });

      it('should have --force option with correct default', () => {
        const forceOption = applyCommand.options.find(
          (opt) => opt.long === '--force'
        );
        expect(forceOption?.defaultValue).toBe(false);
      });

      it('should have no arguments', () => {
        expect(applyCommand.registeredArguments).toHaveLength(0);
      });
    });
  });

  describe('rayfin up db', () => {
    let upDbCommand: Command;

    beforeEach(() => {
      upDbCommand = upCommand.commands.find((cmd) => cmd.name() === 'db')!;
    });

    it('should be registered under up command', () => {
      expect(upDbCommand).toBeDefined();
      expect(upDbCommand.name()).toBe('db');
    });

    it('should have correct description', () => {
      expect(upDbCommand.description()).toBe(
        'Database operations for remote Rayfin item deployment'
      );
    });

    it('should only have apply subcommand', () => {
      const subcommands = upDbCommand.commands.map((cmd) => cmd.name());
      expect(subcommands).toContain('apply');
      expect(subcommands).toHaveLength(1);
    });

    describe('apply subcommand', () => {
      let applyCommand: Command;

      beforeEach(() => {
        applyCommand = upDbCommand.commands.find(
          (cmd) => cmd.name() === 'apply'
        )!;
      });

      it('should have correct name and description', () => {
        expect(applyCommand.name()).toBe('apply');
        expect(applyCommand.description()).toBe(
          'Generate and apply DAB configuration to remote Rayfin item workload endpoint'
        );
      });

      it('should have --force option', () => {
        const options = applyCommand.options.map((opt) => opt.flags);
        expect(options).toContain('--force');
      });

      it('should not have --gen-config-only option', () => {
        const options = applyCommand.options.map((opt) => opt.long);
        expect(options).not.toContain('--gen-config-only');
      });

      it('should have -v as short alias for --verbose', () => {
        const verboseOption = applyCommand.options.find(
          (opt) => opt.long === '--verbose'
        );
        expect(verboseOption).toBeDefined();
        expect(verboseOption?.short).toBe('-v');
      });

      it('should NOT have --remote option (implicitly remote)', () => {
        const options = applyCommand.options.map((opt) => opt.flags);
        expect(options).not.toContain('--remote');
      });

      it('should have --force option with correct default', () => {
        const forceOption = applyCommand.options.find(
          (opt) => opt.long === '--force'
        );
        expect(forceOption?.defaultValue).toBe(false);
      });

      it('should have no arguments', () => {
        expect(applyCommand.registeredArguments).toHaveLength(0);
      });
    });
  });

  describe('command structure comparison', () => {
    it('dev db and up db should have different descriptions', () => {
      const devDbCommand = devCommand.commands.find(
        (cmd) => cmd.name() === 'db'
      );
      const upDbCommand = upCommand.commands.find((cmd) => cmd.name() === 'db');

      expect(devDbCommand?.description()).toContain('local development');
      expect(upDbCommand?.description()).toContain(
        'remote Rayfin item deployment'
      );
    });

    it('both should have apply command with force option', () => {
      const devDbCommand = devCommand.commands.find(
        (cmd) => cmd.name() === 'db'
      );
      const upDbCommand = upCommand.commands.find((cmd) => cmd.name() === 'db');

      const devApply = devDbCommand?.commands.find(
        (cmd) => cmd.name() === 'apply'
      );
      const upApply = upDbCommand?.commands.find(
        (cmd) => cmd.name() === 'apply'
      );

      const devApplyOptions = devApply?.options.map((opt) => opt.long) || [];
      const upApplyOptions = upApply?.options.map((opt) => opt.long) || [];

      expect(devApplyOptions).toContain('--force');
      expect(upApplyOptions).toContain('--force');
    });

    it('neither should have --remote option (context is in command path)', () => {
      const devDbCommand = devCommand.commands.find(
        (cmd) => cmd.name() === 'db'
      );
      const upDbCommand = upCommand.commands.find((cmd) => cmd.name() === 'db');

      const devApply = devDbCommand?.commands.find(
        (cmd) => cmd.name() === 'apply'
      );
      const upApply = upDbCommand?.commands.find(
        (cmd) => cmd.name() === 'apply'
      );

      const devApplyOptions = devApply?.options.map((opt) => opt.long) || [];
      const upApplyOptions = upApply?.options.map((opt) => opt.long) || [];

      expect(devApplyOptions).not.toContain('--remote');
      expect(upApplyOptions).not.toContain('--remote');
    });
  });

  describe('rayfin dev command options', () => {
    it('should have --skip-db-apply option', () => {
      const options = devCommand.options.map((opt) => opt.long);
      expect(options).toContain('--skip-db-apply');
    });

    it('should have --skip-db-apply option with correct default', () => {
      const skipDbApplyOption = devCommand.options.find(
        (opt) => opt.long === '--skip-db-apply'
      );
      expect(skipDbApplyOption?.defaultValue).toBe(false);
    });

    it('should have correct description for --skip-db-apply', () => {
      const skipDbApplyOption = devCommand.options.find(
        (opt) => opt.long === '--skip-db-apply'
      );
      expect(skipDbApplyOption?.description).toContain(
        'Skip automatic database configuration apply'
      );
    });
  });
});
