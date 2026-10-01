import { init } from '@microsoft/rayfin-cli/_internal/commands/init.js';
import { describe, it, expect } from 'vitest';

describe('create-rayfin wrapper', () => {
  it('init() returns a Command named "init"', () => {
    const program = init();
    expect(program.name()).toBe('init');
  });

  it('name can be overridden to "create-rayfin"', () => {
    const program = init();
    program.name('create-rayfin');
    expect(program.name()).toBe('create-rayfin');
  });

  it('has expected options from rayfin init', () => {
    const program = init();
    const longFlags = program.options.map((o: { long?: string }) => o.long);
    expect(longFlags).toContain('--template');
    expect(longFlags).toContain('--list-templates');
    expect(longFlags).toContain('--project-name');
    expect(longFlags).toContain('--workspace');
    expect(longFlags).toContain('--workspace-id');
    expect(longFlags).toContain('--item-id');
  });
});
