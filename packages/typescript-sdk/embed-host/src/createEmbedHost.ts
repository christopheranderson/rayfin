import { assertBrowser } from '@microsoft/rayfin-lib';

import { EmbedHostError } from './errors';
import { createExternalEntraHandoffProvider } from './handoffProvider';
import {
  ACKNOWLEDGEMENT_KIND,
  AUTH_CHANNEL,
  EXTERNAL_EMBED_SCENARIO,
  PROTOCOL_VERSION,
  RESPONSE_KIND,
  isExternalEmbedHandoffRequest,
  isReadinessMessage,
  type ExternalEmbedHandoffPayload,
} from './protocol';
import type { EmbedHost, EmbedHostOptions } from './types';

interface BoundIframe {
  source: NonNullable<MessageEvent['source']>;
  origin: string;
}

/**
 * Registers the parent-side responder that brokers external-Entra
 * authentication for a Rayfin app embedded in an iframe.
 *
 * The returned host answers the embedded app's readiness announcement by
 * acknowledging the `externalEmbed` scenario, then, for the subsequent handoff
 * request, validates the sender and its return origin, calls the app's
 * brokered-authorize endpoint with the parent's own delegated Entra token, and
 * returns the handoff code over the bridge.
 *
 * The parent MUST call this **before** it mounts the Rayfin iframe, so the
 * listener is live when the iframe emits its single readiness signal.
 *
 * @param options - Trust configuration and the delegated-token callback.
 * @returns A handle whose {@link EmbedHost.dispose} removes the listener.
 * @throws `SdkError` when invoked outside a browser environment.
 *
 * @example
 * ```typescript
 * import { createEmbedHost } from '@microsoft/rayfin-embed-host';
 *
 * const host = createEmbedHost({
 *   allowedOrigins: ['https://my-rayfin-app.example.com'],
 *   getAccessToken: () => acquireDelegatedEntraToken(),
 * });
 *
 * // ...later, when the embed is torn down:
 * host.dispose();
 * ```
 */
export function createEmbedHost(options: EmbedHostOptions): EmbedHost {
  assertBrowser('createEmbedHost');

  const allowedOrigins = new Set(options.allowedOrigins);
  const provider =
    options.handoffProvider ?? createExternalEntraHandoffProvider();

  // The iframe bound during the handshake; the handoff request must come from
  // this exact window and origin.
  let bound: BoundIframe | undefined;

  function postResponse(
    source: NonNullable<MessageEvent['source']>,
    origin: string,
    requestId: string,
    body:
      | { success: true; result: { handoffCode: string; state?: string } }
      | { success: false; error: { code: string; message: string } }
  ): void {
    const envelope = {
      channel: AUTH_CHANNEL,
      version: PROTOCOL_VERSION,
      kind: RESPONSE_KIND,
      requestId,
      ...body,
    };
    // `source` is a cross-document Window; target the pinned origin, never "*".
    (source as Window).postMessage(envelope, { targetOrigin: origin });
  }

  async function handleHandoff(
    event: MessageEvent,
    requestId: string,
    payload: ExternalEmbedHandoffPayload
  ): Promise<void> {
    // Source + origin must match the iframe bound during the handshake.
    if (
      !bound ||
      event.source !== bound.source ||
      event.origin !== bound.origin ||
      !allowedOrigins.has(event.origin)
    ) {
      return; // Untrusted sender — drop silently, do not reply.
    }

    // The return origin the code is bound to must be one of the allowlisted app
    // origins — the same list that gated the sender above.
    if (!allowedOrigins.has(payload.callbackUrl)) {
      postResponse(bound.source, bound.origin, requestId, {
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'returnOrigin is not permitted by the embed host.',
        },
      });
      return;
    }

    try {
      const result = await provider.acquire({
        brokeredAuthorizeUrl: payload.brokeredAuthorizeUrl,
        artifactId: payload.artifactId,
        returnOrigin: payload.callbackUrl,
        codeChallenge: payload.codeChallenge,
        codeChallengeMethod: payload.codeChallengeMethod,
        ...(payload.state !== undefined ? { state: payload.state } : {}),
        getAccessToken: options.getAccessToken,
      });
      postResponse(bound.source, bound.origin, requestId, {
        success: true,
        result: {
          handoffCode: result.handoffCode,
          ...(result.state !== undefined ? { state: result.state } : {}),
        },
      });
    } catch (err) {
      const code =
        err instanceof EmbedHostError ? err.code : 'AUTHORIZE_FAILED';
      const message =
        err instanceof EmbedHostError
          ? err.message
          : 'Failed to broker the authentication handoff.';
      postResponse(bound.source, bound.origin, requestId, {
        success: false,
        error: { code, message },
      });
    }
  }

  function handleMessage(event: MessageEvent): void {
    const data = event.data;

    if (isReadinessMessage(data)) {
      if (!event.source || !allowedOrigins.has(event.origin)) {
        return; // Ignore readiness from a non-allowlisted origin.
      }
      bound = { source: event.source, origin: event.origin };
      (event.source as Window).postMessage(
        {
          channel: AUTH_CHANNEL,
          version: PROTOCOL_VERSION,
          kind: ACKNOWLEDGEMENT_KIND,
          requestId: data.requestId,
          scenario: EXTERNAL_EMBED_SCENARIO,
        },
        { targetOrigin: event.origin }
      );
      return;
    }

    if (isExternalEmbedHandoffRequest(data)) {
      void handleHandoff(event, data.requestId, data.payload);
    }
  }

  window.addEventListener('message', handleMessage);

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('message', handleMessage);
      bound = undefined;
    },
  };
}
