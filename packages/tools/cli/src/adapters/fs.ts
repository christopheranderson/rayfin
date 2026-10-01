/**
 * CLI implementation of the {@link Fs} adapter.
 *
 * Backs the async-only filesystem interface with `node:fs/promises`. Keeping
 * Node's `fs` access behind this adapter lets universal workflow and service
 * code declare an `Fs` in its `Deps` without importing `node:*`.
 */
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';

import type { Fs } from '@microsoft/rayfin-tools-common/_internal/adapters';

/** `node:fs/promises`-backed {@link Fs} implementation for the CLI host. */
export const cliFs: Fs = {
  readFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  },

  writeFile(path: string, content: string): Promise<void> {
    return writeFile(path, content, 'utf8');
  },

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },

  readdir(path: string): Promise<string[]> {
    return readdir(path);
  },

  async rm(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};
