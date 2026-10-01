/*
 * externalEmbed wire protocol — iframe (embedded app) side.
 *
 * These `channel`/`kind`/scenario literals are the wire contract shared with
 * the parent embed host (`@microsoft/rayfin-embed-host`). They are owned in the
 * auth layer — the same layer that already owns the `fabric-auth` channel and
 * the `auth.requestHandoff` kind — rather than in the transport package, which
 * stays plugin-agnostic (it defines only the generic envelope; callers supply
 * `channel` and `kind`). The peer package declares the same literals; a
 * contract test in each package pins them to these canonical values so the two
 * ends cannot drift.
 *
 * Canonical values (see docs/rfc/external-entra-embed-host-sdk.md):
 *   channel = "fabric-auth", ready = "externalEmbed.ready",
 *   ack = "externalEmbed.ack", scenario = "externalEmbed".
 *
 * @internal Not exported from the package barrel.
 */

/** Bridge channel carrying Fabric brokered-auth messages. */
export const EXTERNAL_EMBED_AUTH_CHANNEL = 'fabric-auth';

/** `kind` of the iframe's one-shot readiness announcement. */
export const EXTERNAL_EMBED_READY_KIND = 'externalEmbed.ready';

/** `kind` of the parent's scenario acknowledgement. */
export const EXTERNAL_EMBED_ACK_KIND = 'externalEmbed.ack';

/** Scenario tag declared by the acknowledgement. */
export const EXTERNAL_EMBED_SCENARIO = 'externalEmbed';
