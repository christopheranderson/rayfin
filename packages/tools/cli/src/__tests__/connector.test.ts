import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { connectorCommand } from '../commands/connector/connector';

describe('source command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should have correct command name and description', () => {
    expect(connectorCommand.name()).toBe('connector');
    expect(connectorCommand.description()).toBe(
      'Manage external data connectors'
    );
  });

  it('should have invoke, inspect, types, add, list, search, and remove subcommands', () => {
    const subcommands = connectorCommand.commands.map((cmd) => cmd.name());
    expect(subcommands).toContain('invoke');
    expect(subcommands).toContain('inspect');
    expect(subcommands).toContain('search');
    expect(subcommands).toContain('types');
    expect(subcommands).toContain('add');
    expect(subcommands).toContain('list');
    expect(subcommands).toContain('remove');
    expect(subcommands).toHaveLength(7);
  });

  it('should be addable to parent command', () => {
    const parent = new Command('rayfin');
    expect(() => parent.addCommand(connectorCommand)).not.toThrow();
  });

  describe('add subcommand', () => {
    let addCommand: Command;

    beforeEach(() => {
      addCommand = connectorCommand.commands.find(
        (cmd) => cmd.name() === 'add'
      )!;
    });

    it('should have correct description', () => {
      expect(addCommand.description()).toBe(
        'Add an external connector to your Rayfin project'
      );
    });

    it('should have --type as required option', () => {
      const option = addCommand.options.find((opt) => opt.long === '--type');
      expect(option).toBeDefined();
      expect(option?.required).toBe(true);
    });

    it('should have --name option', () => {
      const option = addCommand.options.find((opt) => opt.long === '--name');
      expect(option).toBeDefined();
    });

    it('should have --workspace-id and --item-id options', () => {
      const opts = addCommand.options.map((opt) => opt.long);
      expect(opts).toContain('--workspace-id');
      expect(opts).toContain('--item-id');
    });

    it('should have --verbose option with default false', () => {
      const option = addCommand.options.find((opt) => opt.long === '--verbose');
      expect(option).toBeDefined();
      expect(option?.defaultValue).toBe(false);
    });

    it('should have --yes option with default false', () => {
      const option = addCommand.options.find((opt) => opt.long === '--yes');
      expect(option).toBeDefined();
      expect(option?.defaultValue).toBe(false);
    });
  });

  describe('list subcommand', () => {
    let listCommand: Command;

    beforeEach(() => {
      listCommand = connectorCommand.commands.find(
        (cmd) => cmd.name() === 'list'
      )!;
    });

    it('should have correct description', () => {
      expect(listCommand.description()).toBe('List all configured connectors');
    });

    it('should have --json option', () => {
      const option = listCommand.options.find((opt) => opt.long === '--json');
      expect(option).toBeDefined();
      expect(option?.defaultValue).toBe(false);
    });
  });

  describe('inspect subcommand', () => {
    let inspectCommand: Command;

    beforeEach(() => {
      inspectCommand = connectorCommand.commands.find(
        (cmd) => cmd.name() === 'inspect'
      )!;
    });

    it('should have correct description', () => {
      expect(inspectCommand.description()).toBe(
        'Inspect a connector in read-only mode: list its entities, or sample one with --entity'
      );
    });

    it('should have selector and query mode options', () => {
      const opts = inspectCommand.options.map((opt) => opt.long);
      expect(opts).toContain('--name');
      expect(opts).toContain('--workspace-id');
      expect(opts).toContain('--item-id');
      expect(opts).toContain('--type');
      expect(opts).toContain('--entity');
      expect(opts).toContain('--query');
      expect(opts).toContain('--rows');
    });

    it('should have output options', () => {
      const opts = inspectCommand.options.map((opt) => opt.long);
      expect(opts).toContain('--json');
      expect(opts).toContain('--verbose');

      const outputOption = inspectCommand.options.find(
        (opt) => opt.long === '--output'
      );
      expect(outputOption).toBeDefined();
      expect(outputOption?.argChoices).toEqual([
        'interactive',
        'plain',
        'json',
      ]);
    });
  });

  describe('search subcommand', () => {
    let searchCommand: Command;

    beforeEach(() => {
      searchCommand = connectorCommand.commands.find(
        (cmd) => cmd.name() === 'search'
      )!;
    });

    it('should have --json option with default false', () => {
      const option = searchCommand.options.find((opt) => opt.long === '--json');
      expect(option).toBeDefined();
      expect(option?.defaultValue).toBe(false);
    });

    it('should have --type, --workspace-id, and --all-workspaces options', () => {
      const opts = searchCommand.options.map((opt) => opt.long);
      expect(opts).toContain('--type');
      expect(opts).toContain('--workspace-id');
      expect(opts).toContain('--all-workspaces');
    });

    it('should have --yes and --verbose options and no --add flag', () => {
      const opts = searchCommand.options.map((opt) => opt.long);
      expect(opts).toContain('--yes');
      expect(opts).toContain('--verbose');
      // `--add` was removed: the interactive picker is the default in a TTY,
      // so a separate opt-in flag is redundant.
      expect(opts).not.toContain('--add');
    });

    it('should have --output option with interactive|plain|json choices', () => {
      const option = searchCommand.options.find(
        (opt) => opt.long === '--output'
      );
      expect(option).toBeDefined();
      expect(option?.argChoices).toEqual(['interactive', 'plain', 'json']);
    });

    it('should accept an optional query argument', () => {
      const args = searchCommand.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('query');
      expect(args[0].required).toBe(false);
    });
  });

  describe('types subcommand', () => {
    let typesCommand: Command;

    beforeEach(() => {
      typesCommand = connectorCommand.commands.find(
        (cmd) => cmd.name() === 'types'
      )!;
    });

    it('should have correct description', () => {
      expect(typesCommand.description()).toBe('List supported connector types');
    });

    it('should have --json and --verbose options', () => {
      const opts = typesCommand.options.map((opt) => opt.long);
      expect(opts).toContain('--json');
      expect(opts).toContain('--verbose');
    });

    it('should have --output option with interactive|plain|json choices', () => {
      const option = typesCommand.options.find(
        (opt) => opt.long === '--output'
      );
      expect(option).toBeDefined();
      expect(option?.argChoices).toEqual(['interactive', 'plain', 'json']);
    });
  });

  describe('types subcommand', () => {
    let typesCommand: Command;

    beforeEach(() => {
      typesCommand = connectorCommand.commands.find(
        (cmd) => cmd.name() === 'types'
      )!;
    });

    it('should have correct description', () => {
      expect(typesCommand.description()).toBe('List supported connector types');
    });

    it('should have --json and --verbose options', () => {
      const opts = typesCommand.options.map((opt) => opt.long);
      expect(opts).toContain('--json');
      expect(opts).toContain('--verbose');
    });

    it('should have --output option with interactive|plain|json choices', () => {
      const option = typesCommand.options.find(
        (opt) => opt.long === '--output'
      );
      expect(option).toBeDefined();
      expect(option?.argChoices).toEqual(['interactive', 'plain', 'json']);
    });
  });

  describe('remove subcommand', () => {
    let removeCommand: Command;

    beforeEach(() => {
      removeCommand = connectorCommand.commands.find(
        (cmd) => cmd.name() === 'remove'
      )!;
    });

    it('should have correct description', () => {
      expect(removeCommand.description()).toBe(
        'Remove a data source from your Rayfin project'
      );
    });

    it('should require a name argument', () => {
      const args = removeCommand.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('name');
      expect(args[0].required).toBe(true);
    });

    it('should have --yes option', () => {
      const option = removeCommand.options.find((opt) => opt.long === '--yes');
      expect(option).toBeDefined();
      expect(option?.defaultValue).toBe(false);
    });
  });
});
