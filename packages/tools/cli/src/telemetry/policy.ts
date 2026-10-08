/**
 * Shared telemetry policy resolution for Rayfin Node.js CLI tools.
 *
 * Reads the opt-out environment variable and passes the pre-resolved
 * boolean to the shared {@link isTelemetryEnabled} gate. Used by both
 * `@microsoft/rayfin-cli` and `@microsoft/create-rayfin` so the opt-out
 * behavior is identical across the tool family.
 */

import { isTelemetryEnabled } from '@microsoft/rayfin-tools-common/_internal/telemetry';

/**
 * Resolve the current process environment and return whether telemetry
 * is enabled for Rayfin Node.js CLI tools.
 */
export function isRayfinToolTelemetryEnabled(): boolean {
  const userOptOut = process.env['RAYFIN_TELEMETRY_OPTOUT'] === '1';

  return isTelemetryEnabled({ userOptOut });
}
