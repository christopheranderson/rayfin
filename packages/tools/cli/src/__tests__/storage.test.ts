import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { dev } from '../commands/dev/dev';

describe('storage commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let testProjectDir: string;

  const createProject = ({
    storageEnabled = false,
    envFileContent,
  }: {
    storageEnabled?: boolean;
    envFileContent?: string;
  } = {}) => {
    testProjectDir = join(
      tmpdir(),
      `rayfin-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );

    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
    writeFileSync(
      join(testProjectDir, 'rayfin', 'rayfin.yml'),
      `id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: ${storageEnabled ? 'true' : 'false'}
`
    );

    if (envFileContent) {
      writeFileSync(join(testProjectDir, 'rayfin', '.env'), envFileContent);
    }

    return testProjectDir;
  };

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (testProjectDir) {
      rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  describe('rayfin dev storage', () => {
    let devStorageCommand: Command;

    beforeEach(() => {
      const command = dev(createProject({ storageEnabled: true }), {
        processEnv: {},
      });
      devStorageCommand = command.commands.find(
        (cmd) => cmd.name() === 'storage'
      )!;
    });

    it('should be registered under dev command', () => {
      expect(devStorageCommand).toBeDefined();
      expect(devStorageCommand.name()).toBe('storage');
    });

    it('should have correct description', () => {
      expect(devStorageCommand.description()).toBe(
        'Storage operations for local development'
      );
    });

    it('should register just the apply subcommand', () => {
      const subcommands = devStorageCommand.commands.map((cmd) => cmd.name());
      expect(subcommands).toContain('apply');
      expect(subcommands).toHaveLength(1);
    });

    describe('apply subcommand', () => {
      let applyCommand: Command;

      beforeEach(() => {
        applyCommand = devStorageCommand.commands.find(
          (cmd) => cmd.name() === 'apply'
        )!;
      });

      it('should have correct name and description', () => {
        expect(applyCommand.name()).toBe('apply');
        expect(applyCommand.description()).toBe(
          'Generate and apply storage configuration to local development server'
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

      it('should have --gen-config-only option with correct default', () => {
        const genConfigOnlyOption = applyCommand.options.find(
          (opt) => opt.long === '--gen-config-only'
        );
        expect(genConfigOnlyOption?.defaultValue).toBe(false);
      });

      it('should have no arguments', () => {
        expect(applyCommand.registeredArguments).toHaveLength(0);
      });
    });
  });

  describe('storage command visibility', () => {
    it('shows storage when rayfin.yml enables storage', () => {
      const command = dev(createProject({ storageEnabled: true }), {
        processEnv: {},
      });

      expect(command.commands.some((cmd) => cmd.name() === 'storage')).toBe(
        true
      );
    });

    it('shows storage when RAYFIN_FEATURE_FLAGS enables storage', () => {
      const command = dev(createProject(), {
        processEnv: {
          RAYFIN_FEATURE_FLAGS: 'storage',
        },
      });

      expect(command.commands.some((cmd) => cmd.name() === 'storage')).toBe(
        true
      );
    });

    it('shows storage when rayfin/.env enables storage', () => {
      const command = dev(
        createProject({ envFileContent: 'RAYFIN_FEATURE_FLAGS=storage\n' }),
        {
          processEnv: {},
        }
      );

      expect(command.commands.some((cmd) => cmd.name() === 'storage')).toBe(
        true
      );
    });

    it('hides storage when neither config nor feature flags enable it', () => {
      const command = dev(createProject(), {
        processEnv: {},
      });

      expect(command.commands.some((cmd) => cmd.name() === 'storage')).toBe(
        false
      );
    });
  });
});
