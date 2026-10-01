import { describe, expect, it } from 'vitest';

import {
  coerceType,
  interpolateConfig,
  interpolateString,
} from '../config/index.js';

// ── interpolateString ───────────────────────────────────────────────

describe('interpolateString', () => {
  const env = new Map([
    ['HOST', 'localhost'],
    ['PORT', '5432'],
    ['EMPTY', ''],
  ]);

  it('replaces a simple ${VAR}', () => {
    expect(interpolateString('${HOST}', env, 'test')).toBe('localhost');
  });

  it('replaces multiple vars in one string', () => {
    expect(interpolateString('${HOST}:${PORT}', env, 'test')).toBe(
      'localhost:5432'
    );
  });

  it('uses default when var is missing', () => {
    expect(interpolateString('${MISSING:-fallback}', env, 'test')).toBe(
      'fallback'
    );
  });

  it('uses default when var is empty', () => {
    expect(interpolateString('${EMPTY:-fallback}', env, 'test')).toBe(
      'fallback'
    );
  });

  it('throws when var is missing with no default', () => {
    expect(() => interpolateString('${MISSING}', env, 'ctx')).toThrow(
      "Environment variable 'MISSING'"
    );
  });

  it('leaves non-variable strings unchanged', () => {
    expect(interpolateString('plain text', env, 'test')).toBe('plain text');
  });

  it('unescapes closing braces in defaults', () => {
    expect(interpolateString('${MISSING:-a\\}b}', env, 'test')).toBe('a}b');
  });

  it('handles backslash not followed by closing brace in defaults', () => {
    expect(interpolateString('${MISSING:-path\\nval}', env, 'test')).toBe(
      'path\\nval'
    );
  });
});

// ── coerceType ──────────────────────────────────────────────────────

describe('coerceType', () => {
  it('coerces "true" to boolean', () => {
    expect(coerceType('true')).toBe(true);
    expect(coerceType('True')).toBe(true);
  });

  it('coerces "false" to boolean', () => {
    expect(coerceType('false')).toBe(false);
  });

  it('coerces "null" to null', () => {
    expect(coerceType('null')).toBeNull();
    expect(coerceType('~')).toBeNull();
  });

  it('coerces numeric strings', () => {
    expect(coerceType('42')).toBe(42);
    expect(coerceType('3.14')).toBe(3.14);
  });

  it('keeps non-numeric strings as strings', () => {
    expect(coerceType('hello')).toBe('hello');
    expect(coerceType('123abc')).toBe('123abc');
  });

  it('keeps empty string as empty string', () => {
    expect(coerceType('')).toBe('');
  });
});

// ── interpolateConfig ───────────────────────────────────────────────

describe('interpolateConfig', () => {
  const env = new Map([
    ['DB_HOST', 'localhost'],
    ['DB_PORT', '5432'],
    ['AUTH_ENABLED', 'true'],
  ]);

  it('interpolates nested object values', () => {
    const input = {
      services: {
        data: {
          host: '${DB_HOST}',
          port: '${DB_PORT}',
        },
      },
    };
    const result = interpolateConfig(input, env) as Record<string, unknown>;
    const services = result.services as Record<string, unknown>;
    const data = services.data as Record<string, unknown>;
    expect(data.host).toBe('localhost');
    // Port is a single-var reference → should be coerced to number
    expect(data.port).toBe(5432);
  });

  it('coerces single-var boolean references', () => {
    const input = { enabled: '${AUTH_ENABLED}' };
    const result = interpolateConfig(input, env) as Record<string, unknown>;
    expect(result.enabled).toBe(true);
  });

  it('does not coerce multi-var strings', () => {
    const input = { url: '${DB_HOST}:${DB_PORT}' };
    const result = interpolateConfig(input, env) as Record<string, unknown>;
    expect(result.url).toBe('localhost:5432');
    expect(typeof result.url).toBe('string');
  });

  it('passes through numbers unchanged', () => {
    const input = { port: 3000 };
    const result = interpolateConfig(input, env) as Record<string, unknown>;
    expect(result.port).toBe(3000);
  });

  it('passes through booleans unchanged', () => {
    const input = { enabled: true };
    const result = interpolateConfig(input, env) as Record<string, unknown>;
    expect(result.enabled).toBe(true);
  });

  it('handles arrays', () => {
    const input = { scopes: ['${DB_HOST}', 'literal'] };
    const result = interpolateConfig(input, env) as Record<string, unknown>;
    expect(result.scopes).toEqual(['localhost', 'literal']);
  });

  it('handles null and undefined', () => {
    expect(interpolateConfig(null, env)).toBeNull();
    expect(interpolateConfig(undefined, env)).toBeUndefined();
  });
});
