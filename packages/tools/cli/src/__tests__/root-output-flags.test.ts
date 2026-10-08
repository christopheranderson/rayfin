import { Command } from 'commander';
import { describe, it, expect, vi } from 'vitest';

import { CliHandledError } from '../errors';
import {
  resolveCommandFlags,
  resolveRootOutputFlags,
} from '../utils/output-mode';

/**
 * These tests pin the contract for root-level `--verbose` / `--json`
 * inheritance into subcommand actions. The Commander gotcha they guard
 * against: when a local subcommand option declares a `false` default,
 * `optsWithGlobals()` returns the local `false` (which clobbers the
 * parent's `true`). `resolveRootOutputFlags()` walks to the root and
 * reads `cmd.opts()` directly, sidestepping that clobber.
 */
describe('resolveRootOutputFlags', () => {
  function makeProgram(): {
    root: Command;
    child: Command;
    captured: { command?: Command };
  } {
    const captured: { command?: Command } = {};
    const root = new Command()
      .name('rayfin')
      .exitOverride()
      .option('--verbose', 'verbose', false)
      .option('--json', 'json', false);

    const child = new Command('child')
      // Local declarations preserved for back-compat (per the issue).
      .option('--verbose', 'verbose', false)
      .option('--json', 'json', false)
      .action((_options, command: Command) => {
        captured.command = command;
      });

    root.addCommand(child);
    return { root, child, captured };
  }

  it('returns false/false when neither root nor local flag is set', () => {
    const { root, captured } = makeProgram();
    root.parse(['node', 'rayfin', 'child']);
    expect(resolveRootOutputFlags(captured.command!)).toEqual({
      verbose: false,
      json: false,
    });
  });

  it('reads --verbose set at the root (rayfin --verbose <child>)', () => {
    const { root, captured } = makeProgram();
    root.parse(['node', 'rayfin', '--verbose', 'child']);
    expect(resolveRootOutputFlags(captured.command!).verbose).toBe(true);
  });

  it('reads --json set at the root (rayfin --json <child>)', () => {
    const { root, captured } = makeProgram();
    root.parse(['node', 'rayfin', '--json', 'child']);
    expect(resolveRootOutputFlags(captured.command!).json).toBe(true);
  });

  it('captures `child --verbose` on the root option object too', () => {
    // This documents a critical Commander quirk: when parent AND child both
    // declare the SAME option name, Commander stores the value on the
    // PARENT's option object regardless of where the user types the flag.
    // That means after this PR, local `--verbose` / `--json` redefinitions
    // become help-text-only — the actual value always lives on root, and
    // `command.opts().verbose` on the child stays at its `false` default.
    //
    // Practical consequence: reading `options.verbose` (the action
    // handler's first arg, equivalent to `cmd.opts().verbose`) is
    // unreliable; call sites must use either `resolveRootOutputFlags()`
    // or `optsWithGlobals()` to recover the parent-stored value, and
    // must OR (`||`) with local rather than `??` because the local
    // default is `false`, not `undefined`.
    const { root, child, captured } = makeProgram();
    root.parse(['node', 'rayfin', 'child', '--verbose']);
    expect(resolveRootOutputFlags(captured.command!).verbose).toBe(true);
    // Local stays at its default — illustrates why call sites must OR with
    // the helper rather than rely on `options.verbose`.
    expect(child.opts().verbose).toBe(false);
  });

  it('walks up multiple levels to reach the root', () => {
    // Verifies the helper still works for deeply nested commands like
    // `rayfin up db apply`.
    const root = new Command()
      .name('rayfin')
      .exitOverride()
      .option('--json', 'json', false);
    const mid = new Command('mid');
    let captured: Command | undefined;
    const leaf = new Command('leaf').action((_o, command: Command) => {
      captured = command;
    });
    mid.addCommand(leaf);
    root.addCommand(mid);
    root.parse(['node', 'rayfin', '--json', 'mid', 'leaf']);
    expect(resolveRootOutputFlags(captured!).json).toBe(true);
  });

  it('reads a duplicate --verbose flag typed on a deeply nested leaf command', () => {
    const root = new Command()
      .name('rayfin')
      .exitOverride()
      .option('--verbose', 'verbose', false);
    const mid = new Command('up').option('--verbose', 'verbose', false);
    let captured: Command | undefined;
    const leaf = new Command('deploy')
      .option('--verbose', 'verbose', false)
      .action((_o, command: Command) => {
        captured = command;
      });
    mid.addCommand(leaf);
    root.addCommand(mid);
    root.parse(['node', 'rayfin', 'up', 'deploy', '--verbose']);
    expect(resolveRootOutputFlags(captured!).verbose).toBe(true);
    expect(leaf.opts().verbose).toBe(false);
  });
});

describe('OR-merge pattern guards Commander default-value clobbering', () => {
  // Documents the call-site contract: callers should OR (||) local with
  // root, NEVER ?? — because ?? does not fall through `false`, and a
  // local option with default `false` is always present (not undefined).
  it('local || root.flag returns true when only root flag is set', () => {
    const localOptions: { json?: boolean } = { json: false }; // default
    const rootFlags = { verbose: false, json: true };
    expect(localOptions.json || rootFlags.json).toBe(true);
  });

  it('?? would silently break inheritance for local-defaulted options', () => {
    const localOptions: { json: boolean } = { json: false }; // default
    const rootFlags = { json: true };
    // ?? does not fall through `false`, so root is ignored.
    expect(localOptions.json ?? rootFlags.json).toBe(false);
    // Whereas || does, which is what call sites use.
    expect(localOptions.json || rootFlags.json).toBe(true);
  });
});

/**
 * Sanity coverage for `-y, --yes` inheritance through the same
 * duplicate-declaration pattern. `--yes` is declared on both the root
 * (`src/index.ts`) and several subcommands (`up`, ai-files install,
 * etc.), so it is subject to the same Commander quirk as
 * `--verbose` / `--json`. Unlike those flags, `--yes` consumers
 * (`up.ts`, `dev.ts`, `init.ts`, `ai-files/install.ts`) all read it via
 * `optsWithGlobals()` rather than a dedicated helper, so this block
 * locks down the contract that the merge actually returns `true` for
 * `rayfin --yes <subcommand>` regardless of where the flag is typed.
 *
 * If a future refactor switches a `--yes` consumer to read raw
 * `options.yes` / `command.opts().yes`, these tests will fail and
 * surface the regression before it ships.
 */
describe('--yes inheritance via optsWithGlobals (mirrors `up.ts:201`)', () => {
  function makeYesProgram(): {
    root: Command;
    captured: { mergedYes?: boolean };
  } {
    const captured: { mergedYes?: boolean } = {};
    const root = new Command()
      .name('rayfin')
      .exitOverride()
      .option('-y, --yes', 'Auto-accept all confirmation prompts', false);
    const up = new Command('up')
      .option('-y, --yes', 'Auto-accept all confirmation prompts', false)
      .action((cmdOptions: { yes?: boolean }, command: Command) => {
        // Mirror the exact merge pattern used at
        // `packages/tools/cli/src/commands/up/up.ts:192`.
        const merged = { ...cmdOptions, ...command.optsWithGlobals() } as {
          yes?: boolean;
        };
        captured.mergedYes = Boolean(merged.yes);
      });
    root.addCommand(up);
    return { root, captured };
  }

  it('honors `rayfin --yes up` (root flag inherits via optsWithGlobals)', () => {
    const { root, captured } = makeYesProgram();
    root.parse(['node', 'rayfin', '--yes', 'up']);
    expect(captured.mergedYes).toBe(true);
  });

  it('honors `rayfin up --yes` (local flag still works)', () => {
    const { root, captured } = makeYesProgram();
    root.parse(['node', 'rayfin', 'up', '--yes']);
    expect(captured.mergedYes).toBe(true);
  });

  it('returns false when neither root nor local --yes is set', () => {
    const { root, captured } = makeYesProgram();
    root.parse(['node', 'rayfin', 'up']);
    expect(captured.mergedYes).toBe(false);
  });
});

/**
 * `resolveCommandFlags` is THE single standard flag resolver every leaf
 * command must call. These tests lock down its whole contract so that any
 * future command adopting it — or any refactor of it — keeps the same
 * placement-independent, `--output`-aware, R6-enforcing behavior. They run
 * against the REAL implementation (no `output-mode` mock).
 */
describe('resolveCommandFlags — the single standard flag resolver', () => {
  function makeStdProgram(): {
    root: Command;
    captured: { command?: Command };
  } {
    const captured: { command?: Command } = {};
    const root = new Command()
      .name('rayfin')
      .exitOverride()
      .option('--verbose', 'verbose', false)
      .option('--json', 'json', false)
      .option('-y, --yes', 'yes', false)
      .option('--output <mode>', 'output mode');
    const child = new Command('child')
      .option('--verbose', 'verbose', false)
      .option('--json', 'json', false)
      .option('-y, --yes', 'yes', false)
      .action((_options, command: Command) => {
        captured.command = command;
      });
    root.addCommand(child);
    return { root, captured };
  }

  it('returns all-false defaults (never JSON mode) when no flags are set', () => {
    const { root, captured } = makeStdProgram();
    root.parse(['node', 'rayfin', 'child']);
    const flags = resolveCommandFlags(captured.command!);
    expect(flags.verbose).toBe(false);
    expect(flags.json).toBe(false);
    expect(flags.yes).toBe(false);
    expect(flags.mode).not.toBe('json');
  });

  it.each([
    ['root', ['node', 'rayfin', '--json', 'child']],
    ['subcommand', ['node', 'rayfin', 'child', '--json']],
  ])('honors --json at the %s placement', (_where, argv) => {
    const { root, captured } = makeStdProgram();
    root.parse(argv);
    const flags = resolveCommandFlags(captured.command!);
    expect(flags.json).toBe(true);
    expect(flags.mode).toBe('json');
  });

  it.each([
    ['root', ['node', 'rayfin', '--verbose', 'child']],
    ['subcommand', ['node', 'rayfin', 'child', '--verbose']],
  ])('honors --verbose at the %s placement', (_where, argv) => {
    const { root, captured } = makeStdProgram();
    root.parse(argv);
    const flags = resolveCommandFlags(captured.command!);
    expect(flags.verbose).toBe(true);
    expect(flags.mode).not.toBe('json');
  });

  it.each([
    ['root', ['node', 'rayfin', '--yes', 'child']],
    ['subcommand', ['node', 'rayfin', 'child', '--yes']],
  ])('honors --yes at the %s placement', (_where, argv) => {
    const { root, captured } = makeStdProgram();
    root.parse(argv);
    expect(resolveCommandFlags(captured.command!).yes).toBe(true);
  });

  it('folds --output <mode> from the root into the effective mode', () => {
    const { root, captured } = makeStdProgram();
    root.parse(['node', 'rayfin', '--output', 'json', 'child']);
    const flags = resolveCommandFlags(captured.command!);
    // `--output json` produces JSON mode even though `--json` was not passed.
    expect(flags.json).toBe(false);
    expect(flags.mode).toBe('json');
  });

  it('rejects --verbose combined with --json (R6) with a structured JSON error', () => {
    const { root, captured } = makeStdProgram();
    root.parse(['node', 'rayfin', '--verbose', '--json', 'child']);
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      expect(() => resolveCommandFlags(captured.command!)).toThrow(
        CliHandledError
      );
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('"status":"error"');
      expect(written).toContain('cannot be combined');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('rejects --verbose + --output json (R6) even without --json', () => {
    const { root, captured } = makeStdProgram();
    root.parse(['node', 'rayfin', '--verbose', '--output', 'json', 'child']);
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      expect(() => resolveCommandFlags(captured.command!)).toThrow(
        CliHandledError
      );
    } finally {
      writeSpy.mockRestore();
    }
  });
});
