/**
 * Tests for McpKeyStrategy — JSON key merge, hostile-shape rejection, sibling preservation.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mcpKeyStrategy } from '../strategies/mcp-key.js';
import type { Descriptor } from '../types.js';

const DESCRIPTOR: Descriptor = {
  kind: 'mcp',
  name: 'rayfin',
  bundledAsset: 'mcp-server.json',
};

const BUNDLED = JSON.stringify({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@microsoft/rayfin-mcp', 'start'],
});

let projectRoot: string;
const mcpJsonPath = (root: string) => join(root, '.mcp.json');

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-mcp-strategy-test-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('read', () => {
  it('returns null when .mcp.json is absent', () => {
    expect(mcpKeyStrategy.read(projectRoot, DESCRIPTOR)).toBeNull();
  });

  it('returns null when key is absent', () => {
    writeFileSync(mcpJsonPath(projectRoot), '{}', 'utf8');
    expect(mcpKeyStrategy.read(projectRoot, DESCRIPTOR)).toBeNull();
  });

  it('returns canonicalized JSON when key is present', () => {
    writeFileSync(
      mcpJsonPath(projectRoot),
      JSON.stringify({ mcpServers: { rayfin: { command: 'npx' } } }),
      'utf8'
    );
    const value = mcpKeyStrategy.read(projectRoot, DESCRIPTOR)!;
    expect(JSON.parse(value)).toEqual({ command: 'npx' });
  });
});

describe('write', () => {
  it('creates .mcp.json if missing', () => {
    mcpKeyStrategy.write(projectRoot, DESCRIPTOR, BUNDLED);
    expect(existsSync(mcpJsonPath(projectRoot))).toBe(true);
  });

  it('preserves sibling MCP server entries', () => {
    writeFileSync(
      mcpJsonPath(projectRoot),
      JSON.stringify({
        mcpServers: { other: { command: 'other-server' } },
      }),
      'utf8'
    );
    mcpKeyStrategy.write(projectRoot, DESCRIPTOR, BUNDLED);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(projectRoot), 'utf8'));
    expect(parsed.mcpServers.other).toEqual({ command: 'other-server' });
    expect(parsed.mcpServers.rayfin).toEqual(JSON.parse(BUNDLED));
  });

  it('preserves top-level user keys', () => {
    writeFileSync(
      mcpJsonPath(projectRoot),
      JSON.stringify({
        mcpServers: {},
        inputs: [{ id: 'token', type: 'promptString' }],
      }),
      'utf8'
    );
    mcpKeyStrategy.write(projectRoot, DESCRIPTOR, BUNDLED);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(projectRoot), 'utf8'));
    expect(parsed.inputs).toEqual([{ id: 'token', type: 'promptString' }]);
  });

  it('refuses to write when root is a non-object', () => {
    writeFileSync(mcpJsonPath(projectRoot), '"hello"', 'utf8');
    expect(() =>
      mcpKeyStrategy.write(projectRoot, DESCRIPTOR, BUNDLED)
    ).toThrow(/root must be a JSON object/);
  });

  it('refuses to write when root is an array', () => {
    writeFileSync(mcpJsonPath(projectRoot), '[]', 'utf8');
    expect(() =>
      mcpKeyStrategy.write(projectRoot, DESCRIPTOR, BUNDLED)
    ).toThrow(/root must be a JSON object/);
  });

  it('refuses to write when mcpServers is non-object', () => {
    writeFileSync(
      mcpJsonPath(projectRoot),
      JSON.stringify({ mcpServers: 'not an object' }),
      'utf8'
    );
    expect(() =>
      mcpKeyStrategy.write(projectRoot, DESCRIPTOR, BUNDLED)
    ).toThrow(/must be an object/);
  });

  it('refuses to write when JSON is malformed', () => {
    writeFileSync(mcpJsonPath(projectRoot), '{ not json', 'utf8');
    expect(() =>
      mcpKeyStrategy.write(projectRoot, DESCRIPTOR, BUNDLED)
    ).toThrow(/not valid JSON/);
  });
});

describe('delete', () => {
  it('removes only the rayfin key, preserves siblings', () => {
    writeFileSync(
      mcpJsonPath(projectRoot),
      JSON.stringify({
        mcpServers: {
          rayfin: { command: 'x' },
          other: { command: 'y' },
        },
      }),
      'utf8'
    );
    mcpKeyStrategy.delete(projectRoot, DESCRIPTOR);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(projectRoot), 'utf8'));
    expect(parsed.mcpServers.rayfin).toBeUndefined();
    expect(parsed.mcpServers.other).toEqual({ command: 'y' });
  });

  it('is a no-op when .mcp.json does not exist', () => {
    expect(() => mcpKeyStrategy.delete(projectRoot, DESCRIPTOR)).not.toThrow();
  });

  it('is a no-op when key is absent', () => {
    writeFileSync(
      mcpJsonPath(projectRoot),
      JSON.stringify({ mcpServers: { other: { command: 'y' } } }),
      'utf8'
    );
    mcpKeyStrategy.delete(projectRoot, DESCRIPTOR);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(projectRoot), 'utf8'));
    expect(parsed.mcpServers.other).toEqual({ command: 'y' });
  });
});

describe('hash', () => {
  it('is deterministic and order-independent within objects', () => {
    const a = JSON.stringify({ x: 1, y: 2 });
    const b = JSON.stringify({ y: 2, x: 1 });
    // Both strategies canonicalize before hashing — same input value should match.
    writeFileSync(
      mcpJsonPath(projectRoot),
      JSON.stringify({ mcpServers: { rayfin: JSON.parse(a) } }),
      'utf8'
    );
    const ha = mcpKeyStrategy.hash(
      mcpKeyStrategy.read(projectRoot, DESCRIPTOR)!
    );
    writeFileSync(
      mcpJsonPath(projectRoot),
      JSON.stringify({ mcpServers: { rayfin: JSON.parse(b) } }),
      'utf8'
    );
    const hb = mcpKeyStrategy.hash(
      mcpKeyStrategy.read(projectRoot, DESCRIPTOR)!
    );
    expect(ha).toBe(hb);
  });
});

describe('hasManagedSigil', () => {
  it('always returns false (MCP entries do not carry an ownership sigil)', () => {
    expect(mcpKeyStrategy.hasManagedSigil('any')).toBe(false);
  });
});
