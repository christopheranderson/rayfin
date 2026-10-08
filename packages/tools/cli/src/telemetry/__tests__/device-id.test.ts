import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDevDeviceId } from '../device-id.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('getDevDeviceId', () => {
  let tempDir: string;
  let configDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rayfin-device-id-'));
    configDir = join(tempDir, '.rayfin');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists and reuses a generated ID', async () => {
    const firstDeviceId = await getDevDeviceId(configDir);
    const secondDeviceId = await getDevDeviceId(configDir);

    expect(firstDeviceId).toMatch(UUID_PATTERN);
    expect(secondDeviceId).toBe(firstDeviceId);
    expect(await readFile(join(configDir, 'dev-device-id'), 'utf8')).toBe(
      `${firstDeviceId}\n`
    );

    if (process.platform !== 'win32') {
      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(configDir, 'dev-device-id'))).mode & 0o777).toBe(
        0o600
      );
    }
  });

  it('replaces a malformed persisted ID', async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'dev-device-id'), 'not-a-device-id\n', {
      mode: 0o644,
    });

    const deviceId = await getDevDeviceId(configDir);

    expect(deviceId).toMatch(UUID_PATTERN);
    expect(await readFile(join(configDir, 'dev-device-id'), 'utf8')).toBe(
      `${deviceId}\n`
    );

    if (process.platform !== 'win32') {
      expect((await stat(join(configDir, 'dev-device-id'))).mode & 0o777).toBe(
        0o600
      );
    }
  });
});
