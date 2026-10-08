/**
 * Wire protocol shared with the embedded Rayfin app (the iframe SDK,
 * `@microsoft/rayfin-auth-provider-fabric`).
 *
 * Two message families flow over the same bridge channel:
 *
 * 1. The **classification handshake** — the iframe posts a single
 *    {@link READINESS_KIND} message on load; the parent replies with an
 *    {@link ACKNOWLEDGEMENT_KIND} message declaring the
 *    {@link EXTERNAL_EMBED_SCENARIO} scenario.
 * 2. The **handoff request** — the iframe posts a {@link HANDOFF_REQUEST_KIND}
 *    message ({@link MessageEnvelope} with a `requestId`) whose payload, in the
 *    externalEmbed scenario, carries the app's own brokered-authorize endpoint
 *    and artifact identifier in addition to the PKCE fields; the parent replies
 *    with a correlated response envelope.
 *
 * @internal Protocol detail shared between the embed host and the iframe SDK.
 */

import type { MessageEnvelope } from '@microsoft/fabric-embedded-host';
import { isMessageEnvelope } from '@microsoft/fabric-embedded-host';

/*
 * externalEmbed wire protocol — parent (embed host) side.
 *
 * These `channel`/`kind`/scenario literals are the wire contract shared with
 * the iframe SDK (`@microsoft/rayfin-auth-provider-fabric`). They are owned
 * here rather than imported from the transport package, which stays plugin-
 * agnostic (it defines only the generic envelope; callers supply `channel` and
 * `kind`). The peer package declares the same literals; a contract test in each
 * package pins them to these canonical values so the two ends cannot drift.
 *
 * Canonical values (see docs/rfc/external-entra-embed-host-sdk.md):
 *   channel = "fabric-auth", ready = "externalEmbed.ready",
 *   ack = "externalEmbed.ack", scenario = "externalEmbed".
 */

/** Bridge channel used for Fabric brokered-auth messages. */
export const AUTH_CHANNEL = 'fabric-auth';

/** Protocol version carried on every envelope. */
export const PROTOCOL_VERSION = 1;

/** `kind` of the iframe's one-shot readiness announcement. */
export const READINESS_KIND = 'externalEmbed.ready';

/** `kind` of the parent's scenario acknowledgement. */
export const ACKNOWLEDGEMENT_KIND = 'externalEmbed.ack';

/** Scenario declared by the acknowledgement. */
export const EXTERNAL_EMBED_SCENARIO = 'externalEmbed';

/** `kind` of the correlated handoff request the iframe sends. */
export const HANDOFF_REQUEST_KIND = 'auth.requestHandoff';

/** `kind` of the correlated response the parent sends back. */
export const RESPONSE_KIND = 'response';

/**
 * Payload of a {@link HANDOFF_REQUEST_KIND} message in the externalEmbed
 * scenario.
 *
 * `callbackUrl` is the return origin the iframe expects the handoff code to be
 * usable from; `brokeredAuthorizeUrl` and `artifactId` are supplied by the
 * iframe because the parent has no per-app configuration of its own.
 */
export interface ExternalEmbedHandoffPayload {
  /** Return origin of the embedded app (validated against the allowlist). */
  callbackUrl: string;
  /** PKCE S256 code challenge. */
  codeChallenge: string;
  /** PKCE challenge method — always `"S256"`. */
  codeChallengeMethod: string;
  /** Opaque nonce echoed back for correlation. */
  state: string;
  /** The app's own brokered-authorize endpoint URL. */
  brokeredAuthorizeUrl: string;
  /** The app's Fabric artifact identifier (workload resource moniker). */
  artifactId: string;
}

/**
 * Narrows an untrusted `event.data` to a readiness announcement.
 *
 * @internal
 */
export function isReadinessMessage(data: unknown): data is MessageEnvelope {
  return (
    isMessageEnvelope(data) &&
    data.channel === AUTH_CHANNEL &&
    data.kind === READINESS_KIND
  );
}

/**
 * Narrows an untrusted `event.data` to a handoff request and validates its
 * externalEmbed payload shape.
 *
 * @internal
 */
export function isExternalEmbedHandoffRequest(
  data: unknown
): data is MessageEnvelope & { payload: ExternalEmbedHandoffPayload } {
  if (
    !isMessageEnvelope(data) ||
    data.channel !== AUTH_CHANNEL ||
    data.kind !== HANDOFF_REQUEST_KIND
  ) {
    return false;
  }
  const payload = (data as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.callbackUrl === 'string' &&
    typeof p.codeChallenge === 'string' &&
    typeof p.codeChallengeMethod === 'string' &&
    typeof p.state === 'string' &&
    typeof p.brokeredAuthorizeUrl === 'string' &&
    typeof p.artifactId === 'string'
  );
}
