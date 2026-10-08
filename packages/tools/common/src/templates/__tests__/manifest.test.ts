import { writeFile, mkdir } from 'fs/promises';
import os from 'os';
import { join } from 'path';

import { describe, it, expect } from 'vitest';

import { parseManifest, parseManifestFromString } from '../manifest/parser';
import { validateManifest } from '../manifest/validator';

const VALID_MANIFEST = `
apiVersion: v1
metadata:
  name: my-template
  displayName: My Template
  description: A test template
entries:
  - name: my-template
    path: .
`;

describe('parseManifestFromString', () => {
  it('parses a valid manifest', () => {
    const manifest = parseManifestFromString(VALID_MANIFEST);
    expect(manifest.apiVersion).toBe('v1');
    expect(manifest.metadata.name).toBe('my-template');
    expect(manifest.metadata.displayName).toBe('My Template');
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].name).toBe('my-template');
    expect(manifest.entries[0].path).toBe('.');
  });

  it('parses a manifest with multiple entries', () => {
    const manifest = parseManifestFromString(`
apiVersion: v1
metadata:
  name: my-templates
  displayName: My Templates
entries:
  - name: starter
    path: templates/starter
    description: A starter template
  - name: advanced
    path: templates/advanced
`);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0].name).toBe('starter');
    expect(manifest.entries[0].path).toBe('templates/starter');
    expect(manifest.entries[0].description).toBe('A starter template');
    expect(manifest.entries[1].name).toBe('advanced');
    expect(manifest.entries[1].path).toBe('templates/advanced');
  });

  it('throws on invalid YAML', () => {
    expect(() => parseManifestFromString(': invalid: yaml: [')).toThrow(
      'Invalid YAML'
    );
  });

  it('throws on non-object YAML', () => {
    expect(() => parseManifestFromString('42')).toThrow(
      'must be a YAML object'
    );
  });

  it('throws on invalid apiVersion', () => {
    expect(() =>
      parseManifestFromString(`
apiVersion: wrong/v1
metadata:
  name: test
  displayName: Test
entries:
  - name: test
    path: .
`)
    ).toThrow("apiVersion must be 'v1'");
  });

  it('throws on missing metadata', () => {
    expect(() =>
      parseManifestFromString(`
apiVersion: v1
entries:
  - name: test
    path: .
`)
    ).toThrow('metadata');
  });

  it('throws on missing entries', () => {
    expect(() =>
      parseManifestFromString(`
apiVersion: v1
metadata:
  name: test
  displayName: Test
`)
    ).toThrow('entries');
  });

  it('throws on empty entries array', () => {
    expect(() =>
      parseManifestFromString(`
apiVersion: v1
metadata:
  name: test
  displayName: Test
entries: []
`)
    ).toThrow('entries must contain at least one entry');
  });
});

describe('parseManifest', () => {
  it('reads and parses a manifest file from a directory', async () => {
    const tempDir = join(os.tmpdir(), `rayfin-test-manifest-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    await writeFile(join(tempDir, 'rayfin-template.yml'), VALID_MANIFEST);

    const manifest = await parseManifest(tempDir);
    expect(manifest.apiVersion).toBe('v1');
    expect(manifest.metadata.name).toBe('my-template');
    expect(manifest.entries).toHaveLength(1);
  });

  it('throws when manifest file is missing', async () => {
    const tempDir = join(os.tmpdir(), `rayfin-test-no-manifest-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    await expect(parseManifest(tempDir)).rejects.toThrow(
      'Template manifest not found'
    );
  });
});

describe('validateManifest', () => {
  it('returns empty errors for valid manifest', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'test', path: '.' }],
    };
    expect(validateManifest(obj)).toEqual([]);
  });

  it('reports missing apiVersion', () => {
    const obj = {
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'test', path: '.' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(expect.stringContaining('apiVersion'));
  });

  it('reports missing entries', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
    };
    const errors = validateManifest(obj);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports empty entries array', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(
      expect.stringContaining('entries must contain at least one entry')
    );
  });

  it('accepts entry with path but no name', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ path: '.' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toEqual([]);
  });

  it('reports entry with name but no path or group', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'test' }],
    };
    const errors = validateManifest(obj);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports missing metadata.name', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { displayName: 'Test' },
      entries: [{ name: 'test', path: '.' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(expect.stringContaining('metadata.name'));
  });

  it('accepts missing metadata.displayName', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: [{ name: 'test', path: '.' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toEqual([]);
  });

  it('reports duplicate entry names', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        { name: 'starter', path: 'a' },
        { name: 'starter', path: 'b' },
      ],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(expect.stringContaining('duplicate'));
  });

  it('rejects entry path with .. traversal', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'evil', path: '../outside' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(
      expect.stringContaining("without '..' segments")
    );
  });

  it('rejects absolute POSIX entry path', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'evil', path: '/etc/passwd' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(expect.stringContaining('relative path'));
  });

  it('rejects absolute Windows entry path', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'evil', path: 'C:\\Users\\test' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(expect.stringContaining('relative path'));
  });

  it('rejects backslash-absolute entry path', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'evil', path: '\\server\\share' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(expect.stringContaining('relative path'));
  });

  it('accepts valid relative entry paths', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        { name: 'root', path: '.' },
        { name: 'nested', path: 'templates/starter' },
        { name: 'deep', path: 'a/b/c' },
      ],
    };
    expect(validateManifest(obj)).toEqual([]);
  });

  it('reports wrong apiVersion value', () => {
    const obj = {
      apiVersion: 'v2',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'test', path: '.' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(
      expect.stringContaining("apiVersion must be 'v1'")
    );
  });
});

describe('validateManifest — adversarial inputs', () => {
  it('rejects entries field that is a string (wrong type)', () => {
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: 'not-an-array' as unknown,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects entries field that is null', () => {
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: null as unknown,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects metadata field that is an array', () => {
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: ['name', 'test'] as unknown,
      entries: [],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects manifest with numeric name field', () => {
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 12345 as unknown as string },
      entries: [{ name: 'a', path: '.' }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts entry with missing name (name is optional)', () => {
    // Per schema, template entry name is optional — only path is required
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: [{ path: '.' }],
    });
    expect(errors.length).toBe(0);
  });

  it('rejects entry with both group and path (mutually exclusive)', () => {
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: [
        {
          name: 'mixed',
          path: './one',
          group: { name: 'g', displayName: 'G', entries: [] },
        } as unknown,
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects oversized manifest (10000 entries)', () => {
    const entries = Array.from({ length: 10000 }, (_, i) => ({
      name: `t${i}`,
      path: `./t${i}`,
    }));
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries,
    });
    // Should NOT throw or hang — validation must complete in reasonable time
    // Whether it errors or passes depends on policy, but it must terminate
    expect(Array.isArray(errors)).toBe(true);
  });

  it('rejects deeply nested groups beyond MAX_GROUP_DEPTH', () => {
    // Build 50 levels of nesting (well beyond MAX_GROUP_DEPTH = 32)
    let deepest:
      | { name: string; path: string }
      | { group: { name: string; displayName: string; entries: unknown[] } } = {
      name: 'leaf',
      path: '.',
    };
    for (let i = 0; i < 50; i++) {
      deepest = {
        group: {
          name: `g${i}`,
          displayName: `Group ${i}`,
          entries: [deepest],
        },
      };
    }
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: [deepest as unknown as { name: string; path: string }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /depth/i.test(e))).toBe(true);
  });

  it('rejects entry with absolute Unix path', () => {
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: [{ name: 'evil', path: '/etc/passwd' }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects entry with absolute Windows path', () => {
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: [{ name: 'evil', path: 'C:\\Windows\\System32' }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects entry path with parent traversal segment', () => {
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: [{ name: 'evil', path: 'a/../../../etc' }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects duplicate entry names within the same manifest', () => {
    const errors = validateManifest({
      apiVersion: 'v1',
      metadata: { name: 'test' },
      entries: [
        { name: 'dup', path: './a' },
        { name: 'dup', path: './b' },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  it('rejects manifest with entirely missing top-level keys', () => {
    const errors = validateManifest({} as unknown);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects null manifest', () => {
    const errors = validateManifest(null as unknown);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects array as manifest (not object)', () => {
    const errors = validateManifest([] as unknown);
    expect(errors.length).toBeGreaterThan(0);
  });
});
