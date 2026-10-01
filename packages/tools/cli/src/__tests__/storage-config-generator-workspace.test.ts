import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const compileRayfinDirectory = vi.fn();

vi.mock('../utils/typescript-compiler.js', () => ({
  compileRayfinDirectory: (...args: unknown[]) =>
    compileRayfinDirectory(...args),
}));

describe('generateStorageConfig in a workspace layout', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-storage-ws-'));
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      [
        'id: universal-app',
        'name: Universal App',
        'version: 1.0.0',
        'services:',
        '  storage:',
        '    enabled: true',
        '    path: packages/storage',
      ].join('\n') + '\n'
    );
    // The storage schema sources live inside the workspace package.
    mkdirSync(join(projectRoot, 'packages', 'storage', 'rayfin', 'storage'), {
      recursive: true,
    });
    compileRayfinDirectory.mockReset();
    compileRayfinDirectory.mockResolvedValue({ success: false });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('compiles the storage service root, not the project root', async () => {
    const { generateStorageConfig } =
      await import('../utils/storage-config-generator.js');

    // Compilation is stubbed to fail so the call stops right after we have
    // observed which directory it was pointed at.
    await expect(generateStorageConfig({ projectRoot })).rejects.toThrow(
      /TypeScript compilation failed/
    );

    expect(compileRayfinDirectory).toHaveBeenCalledTimes(1);
    expect(compileRayfinDirectory.mock.calls[0][0]).toBe(
      resolve(projectRoot, 'packages/storage')
    );
  });
});
