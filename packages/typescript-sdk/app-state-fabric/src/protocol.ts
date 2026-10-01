/**
 * Wire protocol constants for the `fabric-app-state` channel.
 *
 * These describe the contract between an embedded Rayfin app and the
 * Fabric host that services it.  They are implementation detail of the
 * client and are not part of the Builder-facing surface.
 *
 * @internal
 */

/** Channel routed by the host's `AppStatePlugin`. */
export const FABRIC_APP_STATE_CHANNEL = 'fabric-app-state';

/** Request kind: read the host's limits and supported features. */
export const KIND_GET_CAPABILITIES = 'appState.getCapabilities';

/** Request kind: read the state the app was launched with. */
export const KIND_GET_LAUNCH_STATE = 'appState.getLaunchState';

/** Request kind: commit state as a new browser history entry. */
export const KIND_PUSH = 'appState.push';

/** Request kind: commit state over the current history entry. */
export const KIND_REPLACE = 'appState.replace';

/** Event kind: the host reports externally-changed state. */
export const KIND_CHANGED = 'appState.changed';
