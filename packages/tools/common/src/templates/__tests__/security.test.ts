import { mkdir, writeFile, symlink, rm } from 'fs/promises';
import os from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { processFiles } from '../engine/file-processor';

describe('security: path traversal', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    sourceDir = join(os.tmpdir(), `rayfin-sec-src-${Date.now()}`);
    targetDir = join(os.tmpdir(), `rayfin-sec-tgt-${Date.now()}`);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true }).catch(() => {});
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  });

  it('sanitizes path separators in rendered filenames', async () => {
    await writeFile(join(sourceDir, '__path__.txt'), 'content');

    const result = await processFiles({
      sourceDir,
      targetDir,
      context: { path: '../../etc/passwd' },
    });

    // Path separators are replaced with underscores, preventing traversal
    expect(result.createdFiles).toContain('.._.._etc_passwd.txt');
  });
});

describe('security: symlink rejection', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    sourceDir = join(os.tmpdir(), `rayfin-sym-src-${Date.now()}`);
    targetDir = join(os.tmpdir(), `rayfin-sym-tgt-${Date.now()}`);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true }).catch(() => {});
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  });

  it('skips source symlinks', async () => {
    // Create a regular file and a symlink to it
    await writeFile(join(sourceDir, 'real.txt'), 'content');
    try {
      await symlink(join(sourceDir, 'real.txt'), join(sourceDir, 'link.txt'));
    } catch {
      // Symlinks may not be available (Windows without admin)
      return;
    }

    const result = await processFiles({
      sourceDir,
      targetDir,
      context: {},
    });

    expect(result.createdFiles).toContain('real.txt');
    expect(result.skippedFiles).toContain('link.txt');
  });
});

describe('security: dry-run', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    sourceDir = join(os.tmpdir(), `rayfin-dry-src-${Date.now()}`);
    targetDir = join(os.tmpdir(), `rayfin-dry-tgt-${Date.now()}`);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true }).catch(() => {});
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  });

  it('lists files without writing in dry-run mode', async () => {
    await writeFile(join(sourceDir, 'hello.txt'), 'Hello World');

    const result = await processFiles({
      sourceDir,
      targetDir,
      context: {},
      dryRun: true,
    });

    expect(result.createdFiles).toContain('hello.txt');

    // Verify the file was NOT actually written
    const { readFile } = await import('fs/promises');
    await expect(
      readFile(join(targetDir, 'hello.txt'), 'utf8')
    ).rejects.toThrow();
  });
});
