import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { mergeRootFilesExclude } from '../utils/vscode-config-utils';

describe('mergeRootFilesExclude', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vscode-cfg-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const readSettings = async (): Promise<Record<string, unknown>> => {
    const raw = await readFile(join(root, '.vscode', 'settings.json'), 'utf8');
    return JSON.parse(raw);
  };

  it('creates settings.json with files.exclude when missing', async () => {
    const result = await mergeRootFilesExclude(root, {
      '**/host.json': true,
    });

    expect(result.written).toBe(true);
    expect(await readSettings()).toEqual({
      'files.exclude': { '**/host.json': true },
    });
  });

  it('preserves unrelated settings and existing excludes', async () => {
    await mkdir(join(root, '.vscode'), { recursive: true });
    await writeFile(
      join(root, '.vscode', 'settings.json'),
      JSON.stringify({
        'editor.tabSize': 2,
        'files.exclude': { '**/.git': true },
      }),
      'utf8'
    );

    const result = await mergeRootFilesExclude(root, {
      '**/host.json': true,
    });

    expect(result.written).toBe(true);
    expect(await readSettings()).toEqual({
      'editor.tabSize': 2,
      'files.exclude': {
        '**/.git': true,
        '**/host.json': true,
      },
    });
  });

  it('never clobbers a user override for the same key', async () => {
    await mkdir(join(root, '.vscode'), { recursive: true });
    await writeFile(
      join(root, '.vscode', 'settings.json'),
      JSON.stringify({
        'files.exclude': { '**/host.json': false },
      }),
      'utf8'
    );

    const result = await mergeRootFilesExclude(root, {
      '**/host.json': true,
      '**/bin': true,
    });

    expect(result.written).toBe(true);
    const settings = await readSettings();
    expect(settings['files.exclude']).toEqual({
      '**/host.json': false,
      '**/bin': true,
    });
  });

  it('is a no-op when every key is already present', async () => {
    await mkdir(join(root, '.vscode'), { recursive: true });
    const original = JSON.stringify({
      'files.exclude': { '**/host.json': true },
    });
    await writeFile(join(root, '.vscode', 'settings.json'), original, 'utf8');

    const result = await mergeRootFilesExclude(root, {
      '**/host.json': true,
    });

    expect(result.written).toBe(false);
    const raw = await readFile(join(root, '.vscode', 'settings.json'), 'utf8');
    expect(raw).toBe(original);
  });

  it('leaves a JSONC file (with comments) untouched', async () => {
    await mkdir(join(root, '.vscode'), { recursive: true });
    const jsonc = '{\n  // keep my comments\n  "editor.tabSize": 4\n}\n';
    await writeFile(join(root, '.vscode', 'settings.json'), jsonc, 'utf8');

    const result = await mergeRootFilesExclude(root, {
      '**/host.json': true,
    });

    expect(result.written).toBe(false);
    const raw = await readFile(join(root, '.vscode', 'settings.json'), 'utf8');
    expect(raw).toBe(jsonc);
  });
});
