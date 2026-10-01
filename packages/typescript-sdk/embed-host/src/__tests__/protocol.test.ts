import { describe, expect, it } from 'vitest';

import {
  ACKNOWLEDGEMENT_KIND,
  AUTH_CHANNEL,
  EXTERNAL_EMBED_SCENARIO,
  HANDOFF_REQUEST_KIND,
  READINESS_KIND,
  RESPONSE_KIND,
} from '../protocol';

/*
 * Wire-contract test.
 *
 * The externalEmbed handshake is a cross-package protocol: this parent SDK and
 * the iframe `@microsoft/rayfin-auth-provider-fabric` each own their own copy
 * of these `channel`/`kind`/scenario literals (the transport package stays
 * plugin-agnostic). Both ends must agree byte-for-byte or the handshake
 * silently fails, so each package pins its constants to the canonical wire
 * values here. The peer package has the identical test for the shared four;
 * changing a value on either side breaks that side's build and forces a
 * deliberate, documented protocol bump.
 *
 * Canonical values: docs/rfc/external-entra-embed-host-sdk.md.
 */
describe('externalEmbed wire protocol (parent side)', () => {
  it('pins the shared handshake constants to their canonical wire values', () => {
    expect(AUTH_CHANNEL).toBe('fabric-auth');
    expect(READINESS_KIND).toBe('externalEmbed.ready');
    expect(ACKNOWLEDGEMENT_KIND).toBe('externalEmbed.ack');
    expect(EXTERNAL_EMBED_SCENARIO).toBe('externalEmbed');
  });

  it('pins the parent-owned request/response kinds', () => {
    expect(HANDOFF_REQUEST_KIND).toBe('auth.requestHandoff');
    expect(RESPONSE_KIND).toBe('response');
  });
});
