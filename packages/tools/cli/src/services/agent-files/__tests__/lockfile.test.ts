/**
 * Tests for the lockfile module — read/write/round-trip + validation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyLockfile,
  readLockfile,
  withItem,
  withoutItem,
  writeLockfile,
  withCliVersion,
} from '../lockfile.js';
import type { ItemId, ItemRecord, Lockfile } from '../types.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-ai-files-test-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('readLockfile', () => {
  it('returns null when the file is absent', () => {
    expect(readLockfile(projectRoot)).toBeNull();
  });

  it('round-trips an empty lockfile', () => {
    const lockfile = emptyLockfile('1.0.0');
    writeLockfile(projectRoot, lockfile);
    const round = readLockfile(projectRoot);
    expect(round).toEqual(lockfile);
  });

  it('round-trips a populated lockfile (legacy records normalize to CLI source)', () => {
    // Legacy records without a `source` field get normalized to the CLI
    // producer on read (Phase 1 has only one producer). Writers always
    // populate source explicitly; readers backfill for forward-compat.
    const legacy: Lockfile = {
      version: 1,
      cliVersion: '1.2.3',
      items: {
        'skill:rayfin': { sha256: 'abc' },
        'mcp:rayfin': { sha256: 'def' },
        'skill:disabled-from-install': { sha256: null, disabled: true },
      },
    };
    writeLockfile(projectRoot, legacy);
    const round = readLockfile(projectRoot);
    const cliSource = { kind: 'cli', id: '@microsoft/rayfin-cli' };
    expect(round).toEqual({
      ...legacy,
      items: {
        'skill:rayfin': { sha256: 'abc', source: cliSource },
        'mcp:rayfin': { sha256: 'def', source: cliSource },
        'skill:disabled-from-install': {
          sha256: null,
          disabled: true,
          source: cliSource,
        },
      },
    });
  });

  it('throws on malformed JSON', () => {
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'rayfin', '.lockfile.json'),
      '{ not json',
      'utf8'
    );
    expect(() => readLockfile(projectRoot)).toThrow(/not valid JSON/);
  });

  it('throws on non-object root', () => {
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'rayfin', '.lockfile.json'),
      '"not an object"',
      'utf8'
    );
    expect(() => readLockfile(projectRoot)).toThrow(
      /root must be a JSON object/
    );
  });

  it('throws on unsupported schema version', () => {
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'rayfin', '.lockfile.json'),
      JSON.stringify({ version: 99, cliVersion: '1', items: {} }),
      'utf8'
    );
    expect(() => readLockfile(projectRoot)).toThrow(
      /unsupported schema version/
    );
  });

  it('throws on invalid item id', () => {
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'rayfin', '.lockfile.json'),
      JSON.stringify({
        version: 1,
        cliVersion: '1.0.0',
        items: { 'invalid-id': { sha256: 'abc' } },
      }),
      'utf8'
    );
    expect(() => readLockfile(projectRoot)).toThrow(/invalid item id/);
  });

  it('accepts null sha256 for disabled-from-install items', () => {
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'rayfin', '.lockfile.json'),
      JSON.stringify({
        version: 1,
        cliVersion: '1.0.0',
        items: { 'skill:rayfin': { sha256: null, disabled: true } },
      }),
      'utf8'
    );
    const lockfile = readLockfile(projectRoot);
    // Legacy record without `source` field is normalized to the CLI producer.
    expect(lockfile?.items['skill:rayfin']).toEqual({
      sha256: null,
      disabled: true,
      source: { kind: 'cli', id: '@microsoft/rayfin-cli' },
    });
  });

  it('rejects sha256 of wrong type', () => {
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'rayfin', '.lockfile.json'),
      JSON.stringify({
        version: 1,
        cliVersion: '1.0.0',
        items: { 'skill:rayfin': { sha256: 123 } },
      }),
      'utf8'
    );
    expect(() => readLockfile(projectRoot)).toThrow(/invalid "sha256"/);
  });
});

describe('writeLockfile', () => {
  it('creates rayfin directory if missing', () => {
    writeLockfile(projectRoot, emptyLockfile('1.0.0'));
    expect(readLockfile(projectRoot)).not.toBeNull();
  });

  it('produces stable output (sorted keys)', () => {
    const a: ItemRecord = { sha256: 'a' };
    const b: ItemRecord = { sha256: 'b' };
    let lockfile = emptyLockfile('1.0.0');
    lockfile = withItem(lockfile, 'skill:zebra' as ItemId, a);
    lockfile = withItem(lockfile, 'mcp:apple' as ItemId, b);
    writeLockfile(projectRoot, lockfile);

    const fs = require('node:fs');
    const raw = fs.readFileSync(
      join(projectRoot, 'rayfin', '.lockfile.json'),
      'utf8'
    ) as string;
    expect(raw.indexOf('mcp:apple')).toBeLessThan(raw.indexOf('skill:zebra'));
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('helpers', () => {
  it('withItem adds a record', () => {
    const lockfile = withItem(emptyLockfile('1'), 'skill:foo' as ItemId, {
      sha256: 'a',
    });
    expect(lockfile.items['skill:foo']).toEqual({ sha256: 'a' });
  });

  it('withoutItem removes a record', () => {
    let lockfile = emptyLockfile('1');
    lockfile = withItem(lockfile, 'skill:foo' as ItemId, { sha256: 'a' });
    lockfile = withoutItem(lockfile, 'skill:foo' as ItemId);
    expect(lockfile.items['skill:foo']).toBeUndefined();
  });

  it('withCliVersion bumps cliVersion', () => {
    const lockfile = withCliVersion(emptyLockfile('1'), '2');
    expect(lockfile.cliVersion).toBe('2');
  });
});
