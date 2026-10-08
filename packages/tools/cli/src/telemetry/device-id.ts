/**
 * Stable installation identifier for CLI telemetry.
 *
 * Generates a random UUID on first use and persists it in the Rayfin user
 * configuration directory so events emitted by the same installation can be
 * correlated across invocations. Resolution is best-effort: callers treat a
 * failure as "no identifier available" and continue without one.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RAYFIN_CONFIG_DIR } from '../auth/constants.js';

const DEV_DEVICE_ID_FILENAME = 'dev-device-id';
const DEV_DEVICE_ID_FILE_MODE = 0o600;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PersistedDeviceId =
  | { status: 'valid'; deviceId: string }
  | { status: 'absent' }
  | { status: 'malformed' };

/**
 * Return a stable, randomly generated identifier for this Rayfin installation.
 *
 * The identifier is stored in the Rayfin user configuration directory and is
 * generated only when no valid persisted value exists.
 *
 * @param configDir - Configuration directory holding the identifier file.
 * @internal
 */
export async function getDevDeviceId(
  configDir = RAYFIN_CONFIG_DIR
): Promise<string> {
  const deviceIdPath = join(configDir, DEV_DEVICE_ID_FILENAME);
  const persisted = await readDeviceId(deviceIdPath);

  if (persisted.status === 'valid') {
    return persisted.deviceId;
  }

  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const generatedDeviceId = randomUUID();

  if (persisted.status === 'malformed') {
    await overwriteDeviceId(deviceIdPath, generatedDeviceId);
    return generatedDeviceId;
  }

  try {
    await writeFile(deviceIdPath, `${generatedDeviceId}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: DEV_DEVICE_ID_FILE_MODE,
    });
    return generatedDeviceId;
  } catch (error) {
    if (getErrorCode(error) !== 'EEXIST') {
      throw error;
    }

    // Another process wrote the file between our read and our write.
    const raced = await readDeviceId(deviceIdPath);
    if (raced.status === 'valid') {
      return raced.deviceId;
    }

    await overwriteDeviceId(deviceIdPath, generatedDeviceId);
    return generatedDeviceId;
  }
}

async function readDeviceId(filePath: string): Promise<PersistedDeviceId> {
  let contents: string;

  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return { status: 'absent' };
    }
    throw error;
  }

  const deviceId = contents.trim();
  return UUID_PATTERN.test(deviceId)
    ? { status: 'valid', deviceId }
    : { status: 'malformed' };
}

async function overwriteDeviceId(
  filePath: string,
  deviceId: string
): Promise<void> {
  await writeFile(filePath, `${deviceId}\n`, {
    encoding: 'utf8',
    mode: DEV_DEVICE_ID_FILE_MODE,
  });
  // `writeFile` ignores `mode` when the file already exists.
  await chmod(filePath, DEV_DEVICE_ID_FILE_MODE);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
