/**
 * Pins the bundled-asset descriptor table.
 *
 * Generally available descriptors ship for every project. Preview descriptors
 * are installed only when their matching feature is enabled.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  getBundledCanonicalAndSha,
  getRayfinDescriptors,
  loadBundledAsset,
} from '../descriptors.js';

let projectRoot: string;
let originalFeatureFlags: string | undefined;

beforeEach(() => {
  originalFeatureFlags = process.env.RAYFIN_FEATURE_FLAGS;
  delete process.env.RAYFIN_FEATURE_FLAGS;
  projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-descriptors-'));
  mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
});

afterEach(() => {
  if (originalFeatureFlags === undefined) {
    delete process.env.RAYFIN_FEATURE_FLAGS;
  } else {
    process.env.RAYFIN_FEATURE_FLAGS = originalFeatureFlags;
  }
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('getRayfinDescriptors', () => {
  it.each(
    getRayfinDescriptors('').filter((descriptor) => descriptor.kind === 'skill')
  )('keeps $name descriptions within the skill loader limit', (descriptor) => {
    const bundled = loadBundledAsset(descriptor);
    const { canonical } = getBundledCanonicalAndSha(descriptor);

    for (const content of [bundled, canonical]) {
      const frontmatter = content
        .replace(/\r\n/g, '\n')
        .match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
      expect(frontmatter).not.toBeNull();
      const { name, description } = parseYaml(frontmatter![1]);

      expect(name).toBe(descriptor.name);
      expect(description).toBeTypeOf('string');
      expect(description.trim().length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(1024);
    }
  });

  it('does not advertise preview skills by default', () => {
    const ids = getRayfinDescriptors(projectRoot).map(
      (d) => `${d.kind}:${d.name}`
    );

    expect(ids).toEqual([
      'skill:rayfin',
      'skill:rayfin-functions',
      'skill:rayfin-connectors',
      'mcp:rayfin',
    ]);
  });

  it('includes the Storage skill when rayfin.yml enables Storage', () => {
    writeFileSync(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      'services:\n  storage:\n    enabled: true\n'
    );

    const storage = getRayfinDescriptors(projectRoot).find(
      (descriptor) => descriptor.name === 'rayfin-storage'
    );

    expect(storage).toBeDefined();
    expect(loadBundledAsset(storage!)).toContain('name: rayfin-storage');
  });

  it('includes the Storage skill when the shell feature flag enables it', () => {
    process.env.RAYFIN_FEATURE_FLAGS = 'storage';

    expect(
      getRayfinDescriptors(projectRoot).map(
        (descriptor) => `${descriptor.kind}:${descriptor.name}`
      )
    ).toContain('skill:rayfin-storage');
  });
});
