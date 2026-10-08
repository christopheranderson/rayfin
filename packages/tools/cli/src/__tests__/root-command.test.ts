import { describe, expect, it } from 'vitest';

import { createRootCommand, isInitInvocation } from '../root-command.js';

const argv = (...args: string[]) => ['node', 'rayfin', ...args];

describe('isInitInvocation', () => {
  it.each([
    ['init'],
    ['init', 'child'],
    ['init', '--help'],
    ['init', '-h'],
    ['init', 'ai-files', '--help'],
    ['--yes', '--json', 'init', 'child'],
    ['--output', 'json', 'init'],
    ['--output=plain', '--yes', 'init'],
    ['init', '--unknown-option'],
  ])('selects init for command arguments %j', (...args) => {
    expect(isInitInvocation(argv(...args))).toBe(true);
  });

  it.each([
    [],
    ['--yes'],
    ['--help'],
    ['-h', 'init'],
    ['--help', 'init'],
    ['--version', 'init'],
    ['-V', 'init'],
    ['help', 'init'],
    ['up', 'init'],
    ['docs', 'search', 'init'],
    ['--unknown-option', 'init'],
    ['--unknown-option=init'],
    ['--yes=true', 'init'],
    ['--', 'init'],
    ['--output'],
    ['--output', 'init'],
    ['--output=init'],
    ['--output', 'init', '--help'],
    ['--output', 'json', '--unknown-option', 'init'],
    ['--output=plain', 'not-a-command', 'init'],
    ['init-other'],
    ['INIT'],
  ])('uses the full graph for command arguments %j', (...args) => {
    expect(isInitInvocation(argv(...args))).toBe(false);
  });

  it('recognizes the non-terminating boolean options declared by the root', () => {
    const root = createRootCommand();
    for (const option of root.options) {
      if (!option.isBoolean() || option.long === '--version') continue;
      for (const flag of [option.short, option.long]) {
        if (flag) expect(isInitInvocation(argv(flag, 'init')), flag).toBe(true);
      }
    }
  });

  it('recognizes each output mode declared by the root', () => {
    const option = createRootCommand().options.find(
      ({ long }) => long === '--output'
    );
    expect(option?.argChoices?.length).toBeGreaterThan(0);
    for (const mode of option?.argChoices ?? []) {
      expect(isInitInvocation(argv('--output', mode, 'init'))).toBe(true);
      expect(isInitInvocation(argv(`--output=${mode}`, 'init'))).toBe(true);
    }
  });
});
