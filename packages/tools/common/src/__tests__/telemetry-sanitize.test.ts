import { describe, expect, it } from 'vitest';

import {
  boundField,
  extractSafeParamNames,
  sanitizeException,
  sanitizeTelemetryProperty,
} from '../telemetry/index.js';

// ── sanitizeException ───────────────────────────────────────────────

describe('sanitizeException', () => {
  it('returns error name and type', () => {
    const error = new TypeError('something went wrong');
    const result = sanitizeException(error);
    expect(result.name).toBe('TypeError');
    expect(result.type).toBe('TypeError');
  });

  it('truncates long messages to 256 characters', () => {
    const longMessage = 'x'.repeat(500);
    const error = new Error(longMessage);
    const result = sanitizeException(error);
    expect(result.message).toHaveLength(256);
  });

  it('strips file paths from messages', () => {
    const error = new Error('Cannot read file /home/user/project/secret.json');
    const result = sanitizeException(error);
    expect(result.message).not.toContain('/home/user');
    expect(result.message).toContain('[path]');
  });

  it('strips Windows file paths from messages', () => {
    const error = new Error(
      'Cannot read file C:\\Users\\admin\\project\\config.yml'
    );
    const result = sanitizeException(error);
    expect(result.message).not.toContain('C:\\Users');
    expect(result.message).toContain('[path]');
  });

  it('returns undefined message for empty error message', () => {
    const error = new Error('');
    const result = sanitizeException(error);
    expect(result.message).toBeUndefined();
  });

  it('handles errors with no constructor name', () => {
    const error = new Error('test');
    Object.defineProperty(error, 'constructor', { value: undefined });
    const result = sanitizeException(error);
    expect(result.type).toBe('Error');
  });
});

// ── extractSafeParamNames ───────────────────────────────────────────

describe('extractSafeParamNames', () => {
  it('extracts flag names from CLI args', () => {
    const args = ['init', '--output', '/tmp/foo', '--verbose', '-f'];
    const result = extractSafeParamNames(args);
    expect(result).toEqual(['--output', '--verbose', '-f']);
  });

  it('strips values from --key=value flags', () => {
    const args = ['--output=/tmp/foo', '--format=json'];
    const result = extractSafeParamNames(args);
    expect(result).toEqual(['--output', '--format']);
  });

  it('excludes bare - and -- separators', () => {
    const args = ['-', '--', '--flag'];
    const result = extractSafeParamNames(args);
    expect(result).toEqual(['--flag']);
  });

  it('returns empty array for no flags', () => {
    const args = ['init', 'my-project'];
    const result = extractSafeParamNames(args);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(extractSafeParamNames([])).toEqual([]);
  });

  it('never includes values following flags', () => {
    const args = ['--output', '/home/user/secret', '--resource-group', 'my-rg'];
    const result = extractSafeParamNames(args);
    // Only flags, never positional values.
    expect(result).toEqual(['--output', '--resource-group']);
    expect(result).not.toContain('/home/user/secret');
    expect(result).not.toContain('my-rg');
  });
});

// ── boundField ──────────────────────────────────────────────────────

describe('boundField', () => {
  it('returns the value unchanged when within limit', () => {
    expect(boundField('hello', 10)).toBe('hello');
  });

  it('truncates to the specified length', () => {
    expect(boundField('hello world', 5)).toBe('hello');
  });

  it('handles empty string', () => {
    expect(boundField('', 10)).toBe('');
  });

  it('handles exact-length string', () => {
    expect(boundField('12345', 5)).toBe('12345');
  });
});

describe('sanitizeTelemetryProperty', () => {
  it('redacts filesystem paths and bounds values', () => {
    expect(sanitizeTelemetryProperty('/home/alice/project/package.json')).toBe(
      '[path]'
    );
    expect(sanitizeTelemetryProperty('x'.repeat(500))).toHaveLength(256);
  });

  it('honors an explicit maximum length', () => {
    expect(sanitizeTelemetryProperty('x'.repeat(100), 36)).toHaveLength(36);
  });
});
