/**
 * `@microsoft/rayfin-embed-host` — the parent-page SDK for embedding a Rayfin
 * app in an iframe and brokering its external-Entra authentication.
 *
 * A third-party portal calls {@link createEmbedHost} before mounting the Rayfin
 * iframe. The host answers the embedded app's readiness handshake, validates
 * each handoff request against the configured trust boundary, and exchanges it
 * for a handoff code by calling the app's brokered-authorize endpoint with the
 * parent's own delegated Entra token.
 *
 * @packageDocumentation
 */

export { createEmbedHost } from './createEmbedHost';
export { EmbedHostError, type EmbedHostErrorCode } from './errors';
export type {
  EmbedHost,
  EmbedHostOptions,
  HandoffProvider,
  HandoffRequest,
  HandoffResult,
} from './types';
