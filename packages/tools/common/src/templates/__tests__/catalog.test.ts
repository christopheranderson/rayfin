import { writeFile, mkdir, symlink, rm } from 'fs/promises';
import os from 'os';
import { join } from 'path';

import { describe, it, expect } from 'vitest';

import {
  flattenManifestEntries,
  getEntriesAtPath,
  resolveEntryPath,
} from '../catalog/resolver';
import { validateManifest } from '../manifest/validator';
import type { ManifestEntry, TemplateManifest } from '../types';

function makeManifest(
  entries: ManifestEntry[],
  overrides: Partial<TemplateManifest> = {}
): TemplateManifest {
  return {
    apiVersion: 'v1',
    metadata: { name: 'test', displayName: 'Test' },
    entries,
    ...overrides,
  };
}

describe('flattenManifestEntries', () => {
  it('flattens simple template entries', () => {
    const entries: ManifestEntry[] = [
      { path: 'templates/basic', name: 'basic' },
      { path: 'templates/advanced', name: 'advanced' },
    ];
    const result = flattenManifestEntries(entries);
    expect(result).toEqual([
      {
        templatePath: 'templates/basic',
        templateName: 'basic',
        displayPath: ['basic'],
      },
      {
        templatePath: 'templates/advanced',
        templateName: 'advanced',
        displayPath: ['advanced'],
      },
    ]);
  });

  it('flattens nested groups', () => {
    const entries: ManifestEntry[] = [
      {
        group: {
          name: 'web',
          displayName: 'Web Apps',
          entries: [
            { path: 'templates/react', name: 'react' },
            {
              group: {
                name: 'api',
                displayName: 'API Templates',
                entries: [{ path: 'templates/rest-api', name: 'rest-api' }],
              },
            },
          ],
        },
      },
    ];
    const result = flattenManifestEntries(entries);
    expect(result).toEqual([
      {
        templatePath: 'templates/react',
        templateName: 'react',
        displayPath: ['Web Apps', 'react'],
      },
      {
        templatePath: 'templates/rest-api',
        templateName: 'rest-api',
        displayPath: ['Web Apps', 'API Templates', 'rest-api'],
      },
    ]);
  });

  it('returns empty array for empty entries', () => {
    expect(flattenManifestEntries([])).toEqual([]);
  });

  it('uses path as display when name is absent', () => {
    const entries: ManifestEntry[] = [{ path: 'templates/basic' }];
    const result = flattenManifestEntries(entries);
    expect(result).toEqual([
      {
        templatePath: 'templates/basic',
        displayPath: ['templates/basic'],
      },
    ]);
  });

  it('populates templateName only when name is present', () => {
    const entries: ManifestEntry[] = [
      { path: 'templates/a', name: 'named' },
      { path: 'templates/b' },
    ];
    const result = flattenManifestEntries(entries);
    expect(result[0].templateName).toBe('named');
    expect(result[1].templateName).toBeUndefined();
  });

  it('throws when group nesting exceeds MAX_GROUP_DEPTH', () => {
    // Build a chain of 33 nested groups (exceeds MAX_GROUP_DEPTH=32)
    let entries: ManifestEntry[] = [{ path: 'leaf', name: 'leaf' }];
    for (let i = 32; i >= 0; i--) {
      entries = [
        {
          group: {
            name: `g${i}`,
            displayName: `Group ${i}`,
            entries,
          },
        },
      ];
    }
    expect(() => flattenManifestEntries(entries)).toThrow('maximum depth');
  });
});

describe('getEntriesAtPath', () => {
  const manifest = makeManifest([
    { path: 'templates/basic', name: 'basic' },
    {
      group: {
        name: 'web',
        displayName: 'Web Apps',
        entries: [
          { path: 'templates/react', name: 'react' },
          {
            group: {
              name: 'api',
              displayName: 'API Templates',
              entries: [{ path: 'templates/rest-api', name: 'rest-api' }],
            },
          },
        ],
      },
    },
  ]);

  it('returns root entries for empty path', () => {
    const result = getEntriesAtPath(manifest, []);
    expect(result).toHaveLength(2);
  });

  it('returns nested group entries', () => {
    const result = getEntriesAtPath(manifest, ['web']);
    expect(result).toHaveLength(2);
  });

  it('returns deeply nested entries', () => {
    const result = getEntriesAtPath(manifest, ['web', 'api']);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for non-existent path', () => {
    const result = getEntriesAtPath(manifest, ['nonexistent']);
    expect(result).toEqual([]);
  });
});

describe('resolveEntryPath', () => {
  it('rejects paths containing ..', async () => {
    await expect(
      resolveEntryPath('/repo', 'templates/../../../etc/passwd')
    ).rejects.toThrow("must not contain '..'");
  });

  it('rejects absolute paths starting with /', async () => {
    await expect(resolveEntryPath('/repo', '/etc/passwd')).rejects.toThrow(
      'must be relative'
    );
  });

  it('rejects absolute paths starting with \\', async () => {
    await expect(
      resolveEntryPath('C:\\repo', '\\Windows\\System32')
    ).rejects.toThrow('must be relative');
  });

  it('rejects Windows drive-letter absolute paths', async () => {
    await expect(
      resolveEntryPath('C:\\repo', 'C:\\Windows\\System32')
    ).rejects.toThrow('must be relative');
  });

  it('resolves a valid template entry', async () => {
    const tempDir = join(os.tmpdir(), `rayfin-test-resolve-${Date.now()}`);
    const templateDir = join(tempDir, 'templates', 'basic');
    await mkdir(templateDir, { recursive: true });
    await writeFile(
      join(templateDir, 'rayfin-template.yml'),
      `apiVersion: v1
metadata:
  name: basic
  displayName: Basic Template
entries:
  - name: basic
    path: .
`
    );

    const result = await resolveEntryPath(tempDir, 'templates/basic');
    expect(result.manifest.metadata.name).toBe('basic');
    await rm(tempDir, { recursive: true, force: true });
  });

  // Symlink escape test — only runs on POSIX
  if (os.platform() !== 'win32') {
    it('rejects symlink that escapes the repository root', async () => {
      const repoDir = join(
        os.tmpdir(),
        `rayfin-test-symlink-escape-${Date.now()}`
      );
      const outsideDir = join(os.tmpdir(), `rayfin-test-outside-${Date.now()}`);
      await mkdir(join(repoDir, 'templates'), { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await writeFile(
        join(outsideDir, 'rayfin-template.yml'),
        `apiVersion: v1\nmetadata:\n  name: escaped\n  displayName: Escaped\nentries:\n  - name: x\n    path: .\n`
      );
      await symlink(outsideDir, join(repoDir, 'templates', 'evil'));

      await expect(resolveEntryPath(repoDir, 'templates/evil')).rejects.toThrow(
        'escapes repository root via symlink'
      );

      await rm(repoDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    });
  }
});

describe('manifest validation with groups', () => {
  it('validates a simple manifest', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'basic', path: 'templates/basic' }],
    };
    expect(validateManifest(obj)).toEqual([]);
  });

  it('validates manifest with groups', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        {
          group: {
            name: 'web',
            displayName: 'Web',
            entries: [{ name: 'react', path: 'templates/react' }],
          },
        },
      ],
    };
    expect(validateManifest(obj)).toEqual([]);
  });

  it('rejects entry with both group and path', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        {
          group: { name: 'g', displayName: 'G', entries: [{ path: 'a' }] },
          path: 'foo',
        },
      ],
    };
    const errors = validateManifest(obj);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports entry with neither group nor path', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{}],
    };
    const errors = validateManifest(obj);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports group missing required fields', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        { group: { displayName: 'Web', entries: [{ name: 'a', path: 'a' }] } },
      ],
    };
    const errors = validateManifest(obj);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports empty group entries', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        { group: { name: 'empty', displayName: 'Empty', entries: [] } },
      ],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(
      expect.stringContaining('entries must not be empty')
    );
  });

  it('reports duplicate template names across groups', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        {
          group: {
            name: 'a',
            displayName: 'A',
            entries: [{ name: 'starter', path: 'templates/x' }],
          },
        },
        {
          group: {
            name: 'b',
            displayName: 'B',
            entries: [{ name: 'starter', path: 'templates/y' }],
          },
        },
      ],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(
      expect.stringContaining("'starter' is a duplicate")
    );
  });

  it('reports duplicate group names among siblings', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        {
          group: {
            name: 'web',
            displayName: 'Web',
            entries: [{ name: 'a', path: 'templates/a' }],
          },
        },
        {
          group: {
            name: 'web',
            displayName: 'Web Apps',
            entries: [{ name: 'b', path: 'templates/b' }],
          },
        },
      ],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(
      expect.stringContaining("group.name 'web' is a duplicate")
    );
  });

  it('reports name-path collision', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'bar', path: 'foo' }, { path: 'bar' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(
      expect.stringContaining('collides with an entry name')
    );
  });

  it('reports duplicate paths', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        { name: 'a', path: 'templates/foo' },
        { name: 'b', path: 'templates/foo' },
      ],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(expect.stringContaining('is a duplicate'));
  });

  it('reports invalid name type', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ path: 'templates/foo', name: 42 }],
    };
    const errors = validateManifest(obj);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validates nested group entries recursively', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        {
          group: {
            name: 'web',
            displayName: 'Web',
            entries: [{ path: '' }],
          },
        },
      ],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(
      expect.stringContaining('path must be a non-empty string')
    );
  });

  it('reports empty root entries', () => {
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

  it('accepts entry where name equals path (no false collision)', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'foo', path: 'foo' }],
    };
    const errors = validateManifest(obj);
    expect(errors).toEqual([]);
  });

  it('reports duplicate template names within same level', () => {
    const obj = {
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [
        { name: 'starter', path: 'templates/a' },
        { name: 'starter', path: 'templates/b' },
      ],
    };
    const errors = validateManifest(obj);
    expect(errors).toContainEqual(
      expect.stringContaining("'starter' is a duplicate")
    );
  });
});
