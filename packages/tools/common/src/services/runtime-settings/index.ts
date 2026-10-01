/**
 * Runtime-settings product-service contract (Layer 3).
 *
 * Owns the whole boundary between the Builder-facing Rayfin model and the
 * workload's `projectRuntimeSettings` contract: outbound translation of
 * `services` to the wire shape, and inbound translation of the workload's
 * error vocabulary back into the fields a Builder actually edits.
 *
 * Both directions live here so there is one cross-host source of truth. The
 * Fabric and Docker transports differ in how they send the body, not in what
 * the body means, and a host that translated only one direction would tell a
 * Builder to fix a field that does not exist in `rayfin.yml`.
 *
 * Transport stays with each host: tokens, retries, headers, and the fetch
 * itself are not this module's concern. `config/` likewise stays limited to the
 * in-memory and on-disk model, with no knowledge of the endpoint.
 */
export {
  toRuntimeSettingsServices,
  preserveRecordedRuntimeSettings,
} from './runtimeSettings.js';
export type {
  RuntimeSettingsServices,
  PreserveRecordedRuntimeSettingsInput,
} from './runtimeSettings.js';
export { translateStaticHostingAccessError } from './errors.js';
