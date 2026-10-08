/**
 * Internal telemetry barrel for Rayfin Node.js CLI tools.
 *
 * Exposes the Node-only telemetry helpers shared between
 * `@microsoft/rayfin-cli` and `@microsoft/create-rayfin` via the
 * `@microsoft/rayfin-cli/_internal/telemetry` subpath export. The
 * surface area is intentionally minimal: consumers compose these with
 * their own OpenTelemetry bootstrap and Commander wiring.
 *
 * NOTE: This is a transitional home for these helpers. A planned
 * code-sharing refactor will extract the Node-only telemetry layer
 * into a dedicated private package alongside a broader rework of the
 * tools-common split. Until then, `create-rayfin` imports through
 * this subpath to keep the opt-out behavior, first-run notice, and
 * context handling consistent with the CLI.
 */

export { getCurrentContext, setCurrentContext } from './context-store.js';
export { getDevDeviceId } from './device-id.js';
export {
  addTelemetryEnvironment,
  recordFabricResponseActivity,
} from './enrichment.js';
export { showFirstRunNoticeIfNeeded } from './first-run-notice.js';
export { isRayfinToolTelemetryEnabled } from './policy.js';
