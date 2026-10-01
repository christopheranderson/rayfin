// ── Deep-link application state ──────────────────────────────
//
// The URL representation is owned by the host and is deliberately NOT
// exported: no parameter name, no codec, no channel constant. Exporting
// them would let a Builder depend on the encoding, which is the one
// thing this design exists to keep changeable. They remain importable
// from the individual modules for tests and for the host-side contract.

export type {
  FabricAppState,
  FabricAppStateValue,
  FabricAppStateCapabilities,
  FabricAppStateClient,
  FabricAppStateClientOptions,
  FabricAppStateListener,
} from './types';
export { createFabricAppStateClient } from './fabricAppState';
export { FabricAppStateError } from './errors';
export { DEFAULT_MAX_ENCODED_BYTES, DEFAULT_MAX_DEPTH } from './validation';
