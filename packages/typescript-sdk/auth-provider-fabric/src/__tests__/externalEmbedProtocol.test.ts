import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_EMBED_ACK_KIND,
  EXTERNAL_EMBED_AUTH_CHANNEL,
  EXTERNAL_EMBED_READY_KIND,
  EXTERNAL_EMBED_SCENARIO,
} from '../externalEmbedProtocol';

/*
 * Wire-contract test.
 *
 * The externalEmbed handshake is a cross-package protocol: this iframe SDK and
 * the parent `@microsoft/rayfin-embed-host` each own their own copy of these
 * `channel`/`kind`/scenario literals (the transport package stays plugin-
 * agnostic). Both ends must agree byte-for-byte or the handshake silently
 * fails, so each package pins its constants to the canonical wire values here.
 * The peer package has the identical test; changing a value on either side
 * breaks that side's build and forces a deliberate, documented protocol bump.
 *
 * Canonical values: docs/rfc/external-entra-embed-host-sdk.md.
 */
describe('externalEmbed wire protocol (iframe side)', () => {
  it('pins the handshake constants to their canonical wire values', () => {
    expect(EXTERNAL_EMBED_AUTH_CHANNEL).toBe('fabric-auth');
    expect(EXTERNAL_EMBED_READY_KIND).toBe('externalEmbed.ready');
    expect(EXTERNAL_EMBED_ACK_KIND).toBe('externalEmbed.ack');
    expect(EXTERNAL_EMBED_SCENARIO).toBe('externalEmbed');
  });
});
