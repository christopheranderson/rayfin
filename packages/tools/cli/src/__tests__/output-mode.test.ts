import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { isInteractive, resolveOutputMode } from '../utils/output-mode';

describe('isInteractive', () => {
  const originalStdin = process.stdin.isTTY;
  const originalCI = process.env.CI;

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    delete process.env.CI;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
    if (originalCI !== undefined) {
      process.env.CI = originalCI;
    } else {
      delete process.env.CI;
    }
  });

  it('returns true when TTY and no flags', () => {
    expect(isInteractive()).toBe(true);
  });

  it('returns false when --yes flag is set', () => {
    expect(isInteractive({ yes: true })).toBe(false);
  });

  it('returns false when stdin is not a TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: undefined,
      configurable: true,
    });
    expect(isInteractive()).toBe(false);
  });

  it('returns false when CI=true', () => {
    process.env.CI = 'true';
    expect(isInteractive()).toBe(false);
  });

  it('returns true when CI is set to non-true value', () => {
    process.env.CI = 'false';
    expect(isInteractive()).toBe(true);
  });

  it('--yes takes precedence over TTY', () => {
    expect(isInteractive({ yes: true })).toBe(false);
  });
});

describe('resolveOutputMode', () => {
  const originalStdout = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdout,
      writable: true,
      configurable: true,
    });
  });

  it('returns json when --json flag is set', () => {
    expect(resolveOutputMode({ json: true })).toBe('json');
  });

  it('returns interactive when stdout is TTY and no flags', () => {
    expect(resolveOutputMode({})).toBe('interactive');
  });

  it('returns plain when stdout is not TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: undefined,
      configurable: true,
    });
    expect(resolveOutputMode({})).toBe('plain');
  });

  it('json takes precedence over TTY detection', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: undefined,
      configurable: true,
    });
    expect(resolveOutputMode({ json: true })).toBe('json');
  });
});
