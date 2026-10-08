import { mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { instantiateTemplate } from '../engine/instantiator';
import type { ResolvedTemplate } from '../types';

describe('instantiateTemplate', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    sourceDir = join(os.tmpdir(), `rayfin-inst-src-${Date.now()}`);
    targetDir = join(os.tmpdir(), `rayfin-inst-tgt-${Date.now()}`);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true }).catch(() => {});
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  });

  it('copies files to target directory', async () => {
    await writeFile(join(sourceDir, 'hello.txt'), 'Hello World');

    const template: ResolvedTemplate = {
      manifest: {
        apiVersion: 'v1',
        metadata: { name: 'test', displayName: 'Test' },
        entries: [{ name: 'test', path: '.' }],
      },
      sourcePath: sourceDir,
    };

    const result = await instantiateTemplate(template, { targetDir });

    expect(result.createdFiles).toContain('hello.txt');
    expect(result.targetDir).toBe(targetDir);
    expect(result.skippedFiles).toEqual([]);
  });

  it('passes presets as context for placeholder rendering', async () => {
    await writeFile(join(sourceDir, '__name__.txt'), 'content');

    const template: ResolvedTemplate = {
      manifest: {
        apiVersion: 'v1',
        metadata: { name: 'test', displayName: 'Test' },
        entries: [{ name: 'test', path: '.' }],
      },
      sourcePath: sourceDir,
    };

    const result = await instantiateTemplate(template, {
      targetDir,
      presets: { name: 'my-app' },
    });

    expect(result.createdFiles).toContain('my-app.txt');
    expect(result.parameters).toEqual({ name: 'my-app' });
  });

  it('respects dryRun option', async () => {
    await writeFile(join(sourceDir, 'file.txt'), 'content');

    const template: ResolvedTemplate = {
      manifest: {
        apiVersion: 'v1',
        metadata: { name: 'test', displayName: 'Test' },
        entries: [{ name: 'test', path: '.' }],
      },
      sourcePath: sourceDir,
    };

    const result = await instantiateTemplate(template, {
      targetDir,
      dryRun: true,
    });

    expect(result.createdFiles).toContain('file.txt');

    // File should not actually exist
    const { readFile } = await import('fs/promises');
    await expect(
      readFile(join(targetDir, 'file.txt'), 'utf8')
    ).rejects.toThrow();
  });

  it('returns empty parameters when no presets given', async () => {
    await writeFile(join(sourceDir, 'file.txt'), 'content');

    const template: ResolvedTemplate = {
      manifest: {
        apiVersion: 'v1',
        metadata: { name: 'test', displayName: 'Test' },
        entries: [{ name: 'test', path: '.' }],
      },
      sourcePath: sourceDir,
    };

    const result = await instantiateTemplate(template, { targetDir });

    expect(result.parameters).toEqual({});
  });
});
