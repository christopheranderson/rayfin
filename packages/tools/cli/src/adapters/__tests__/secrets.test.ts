import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cliSecretStore } from '../secrets.js';

vi.mock('node:fs/promises');

// Pin the config dir so path assertions are deterministic and no real
// filesystem location is touched.
vi.mock('../../auth/constants.js', () => ({
  RAYFIN_CONFIG_DIR: '/tmp/.rayfin-secrets-test',
}));

const SECRETS_PATH = join('/tmp/.rayfin-secrets-test', 'secrets.json');

describe('cliSecretStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('round-trips a value through set then get', async () => {
    vi.mocked(readFile).mockResolvedValue('{}');
    await cliSecretStore.set('token', 'abc');

    // set persists the merged map; assert what was written, then simulate
    // reading it back.
    const written = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(JSON.parse(written)).toEqual({ token: 'abc' });

    vi.mocked(readFile).mockResolvedValue(written);
    expect(await cliSecretStore.get('token')).toBe('abc');
  });

  it('overwrites an existing key (last write wins)', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ token: 'old' }));
    await cliSecretStore.set('token', 'new');

    const written = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(JSON.parse(written)).toEqual({ token: 'new' });
  });

  it('returns undefined when the store file is missing', async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );
    expect(await cliSecretStore.get('token')).toBeUndefined();
  });

  it('returns undefined when the store file holds corrupt JSON', async () => {
    vi.mocked(readFile).mockResolvedValue('{ not valid json');
    expect(await cliSecretStore.get('token')).toBeUndefined();
  });

  it('treats a non-object JSON payload as an empty store', async () => {
    vi.mocked(readFile).mockResolvedValue('["array","not","object"]');
    expect(await cliSecretStore.get('token')).toBeUndefined();
  });

  it('does not write when deleting a key that is absent from a missing store', async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );

    await cliSecretStore.delete('token');

    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes the pruned map when deleting a key that exists', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ token: 'abc', other: 'keep' })
    );

    await cliSecretStore.delete('token');

    const written = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(JSON.parse(written)).toEqual({ other: 'keep' });
  });

  it('persists with the owner-only 0o600 file mode and 0o700 dir mode', async () => {
    vi.mocked(readFile).mockResolvedValue('{}');

    await cliSecretStore.set('token', 'abc');

    expect(mkdir).toHaveBeenCalledWith(
      '/tmp/.rayfin-secrets-test',
      expect.objectContaining({ recursive: true, mode: 0o700 })
    );
    expect(writeFile).toHaveBeenCalledWith(
      SECRETS_PATH,
      expect.any(String),
      expect.objectContaining({ mode: 0o600 })
    );
  });
});
