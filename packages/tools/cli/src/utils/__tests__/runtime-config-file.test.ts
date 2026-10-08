import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  RUNTIME_CONFIG_FILENAME,
  removeRuntimeConfigFile,
  writeRuntimeConfigFile,
} from '../runtime-config-file.js';

describe('runtime-config-file', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `rayfin-runtime-config-${randomUUID()}`);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('writeRuntimeConfigFile', () => {
    it('creates the target directory and writes the flattened config', async () => {
      const dir = join(testDir, 'public');
      const result = await writeRuntimeConfigFile(dir, {
        apiUrl: 'https://api.example/backend',
        publishableKey: 'pk-123',
        workspaceId: 'ws-1',
        itemId: 'item-1',
        portalUrl: 'https://portal.example',
        tenantId: 'tenant-1',
      });

      expect(result.path).toBe(join(dir, RUNTIME_CONFIG_FILENAME));
      expect(result.preexisting).toBe(false);
      expect(existsSync(result.path)).toBe(true);

      const parsed = JSON.parse(await readFile(result.path, 'utf8'));
      expect(parsed).toEqual({
        apiUrl: 'https://api.example/backend',
        publishableKey: 'pk-123',
        workspaceId: 'ws-1',
        itemId: 'item-1',
        portalUrl: 'https://portal.example',
        tenantId: 'tenant-1',
      });
    });

    it('omits undefined optional fields and never emits a serviceMode', async () => {
      const result = await writeRuntimeConfigFile(testDir, {
        apiUrl: 'https://api.example/backend',
      });

      const parsed = JSON.parse(await readFile(result.path, 'utf8'));
      expect(parsed).toEqual({ apiUrl: 'https://api.example/backend' });
      expect(parsed).not.toHaveProperty('serviceMode');
      expect(parsed).not.toHaveProperty('publishableKey');
    });

    it('writes trailing-newline-terminated pretty JSON', async () => {
      const result = await writeRuntimeConfigFile(testDir, {
        apiUrl: 'https://api.example/backend',
      });
      const raw = await readFile(result.path, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).toContain('\n  "apiUrl"');
    });

    it('reports preexisting=true and leaves an existing file untouched', async () => {
      const dir = join(testDir, 'public');
      await mkdir(dir, { recursive: true });
      const existingContent = JSON.stringify(
        { apiUrl: 'https://existing.example' },
        null,
        2
      );
      await writeFile(
        join(dir, RUNTIME_CONFIG_FILENAME),
        existingContent,
        'utf8'
      );

      const result = await writeRuntimeConfigFile(dir, {
        apiUrl: 'https://fresh.example/backend',
      });

      expect(result.preexisting).toBe(true);
      const raw = await readFile(result.path, 'utf8');
      expect(raw).toBe(existingContent);
      const parsed = JSON.parse(raw);
      expect(parsed.apiUrl).toBe('https://existing.example');
    });

    it('reports a difference when a preexisting file does not match this deploy', async () => {
      const dir = join(testDir, 'public');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, RUNTIME_CONFIG_FILENAME),
        JSON.stringify({ apiUrl: 'https://existing.example' }, null, 2),
        'utf8'
      );

      const result = await writeRuntimeConfigFile(dir, {
        apiUrl: 'https://fresh.example/backend',
      });

      expect(result.differences).toEqual([
        'apiUrl: existing="https://existing.example" vs this deploy="https://fresh.example/backend"',
      ]);
    });

    it('reports no differences when a preexisting file already matches this deploy', async () => {
      const dir = join(testDir, 'public');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, RUNTIME_CONFIG_FILENAME),
        JSON.stringify({ apiUrl: 'https://same.example' }, null, 2),
        'utf8'
      );

      const result = await writeRuntimeConfigFile(dir, {
        apiUrl: 'https://same.example',
      });

      expect(result.preexisting).toBe(true);
      expect(result.differences).toEqual([]);
    });

    it('reports a single explanatory difference when the preexisting file is not valid JSON', async () => {
      const dir = join(testDir, 'public');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, RUNTIME_CONFIG_FILENAME),
        '{ not valid json',
        'utf8'
      );

      const result = await writeRuntimeConfigFile(dir, {
        apiUrl: 'https://fresh.example/backend',
      });

      expect(result.differences).toEqual([
        'existing file could not be parsed to compare against this deploy',
      ]);
    });

    it('reports no differences for a freshly written file', async () => {
      const result = await writeRuntimeConfigFile(testDir, {
        apiUrl: 'https://api.example/backend',
      });

      expect(result.differences).toEqual([]);
    });
  });

  describe('removeRuntimeConfigFile', () => {
    it('deletes a previously written config file', async () => {
      const { path } = await writeRuntimeConfigFile(testDir, {
        apiUrl: 'https://api.example/backend',
      });
      expect(existsSync(path)).toBe(true);

      await removeRuntimeConfigFile(path);
      expect(existsSync(path)).toBe(false);
    });

    it('is a no-op for an undefined path', async () => {
      await expect(removeRuntimeConfigFile(undefined)).resolves.toBeUndefined();
    });

    it('does not throw when the file is already absent', async () => {
      const path = join(testDir, RUNTIME_CONFIG_FILENAME);
      expect(existsSync(path)).toBe(false);
      await expect(removeRuntimeConfigFile(path)).resolves.toBeUndefined();
    });
  });

  describe('generate-then-delete lifecycle', () => {
    it('leaves no file on disk after a write followed by a remove', async () => {
      const dir = join(testDir, 'public');
      const { path } = await writeRuntimeConfigFile(dir, {
        apiUrl: 'https://api.example/backend',
        publishableKey: 'pk-abc',
      });
      expect(existsSync(path)).toBe(true);

      // Mirrors the command's finally block: cleanup runs regardless of the
      // deploy outcome, so the transient never shadows local-dev VITE_* values.
      await removeRuntimeConfigFile(path);
      expect(existsSync(path)).toBe(false);
    });

    it('preserves a pre-existing file across a full deploy cycle when the caller skips cleanup for it', async () => {
      const dir = join(testDir, 'public');
      await mkdir(dir, { recursive: true });
      const preexistingContent = JSON.stringify(
        { apiUrl: 'https://hand-committed.example' },
        null,
        2
      );
      const configPath = join(dir, RUNTIME_CONFIG_FILENAME);
      await writeFile(configPath, preexistingContent, 'utf8');

      // "Deploy" step: write (a no-op here since the file preexists), then —
      // mirroring workflow.ts/up.ts's guard — only remove when this run
      // actually wrote the file.
      const written = await writeRuntimeConfigFile(dir, {
        apiUrl: 'https://fresh.example/backend',
      });
      expect(written.preexisting).toBe(true);
      if (!written.preexisting) {
        await removeRuntimeConfigFile(written.path);
      }

      expect(existsSync(configPath)).toBe(true);
      expect(await readFile(configPath, 'utf8')).toBe(preexistingContent);
    });
  });
});
