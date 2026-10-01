/**
 * A validated request to broker one external-Entra handoff.
 *
 * Passed to the handoff provider after the embed host has verified the
 * originating iframe and its return origin. The endpoint URL and artifact id
 * are supplied by the iframe; the token is obtained lazily via
 * {@link HandoffRequest.getAccessToken} so it is never held in embed-host state.
 */
export interface HandoffRequest {
  /** The app's brokered-authorize endpoint URL to `POST` to. */
  brokeredAuthorizeUrl: string;
  /** The app's Fabric artifact id, sent as the workload resource moniker. */
  artifactId: string;
  /** Return origin the resulting handoff code is bound to. */
  returnOrigin: string;
  /** PKCE S256 code challenge. */
  codeChallenge: string;
  /** PKCE challenge method — always `"S256"`. */
  codeChallengeMethod: string;
  /** Opaque correlation nonce, echoed back when present. */
  state?: string;
  /** Lazily yields the parent's delegated Entra access token for this request. */
  getAccessToken: () => string | Promise<string>;
}

/**
 * The handoff code (and echoed `state`) returned by the handoff provider.
 */
export interface HandoffResult {
  /** Single-use handoff code the iframe exchanges for tokens. */
  handoffCode: string;
  /** Correlation nonce, present only if the request supplied one. */
  state?: string;
}

/**
 * Pluggable acquisition seam.
 *
 * The default provider calls the brokered-authorize endpoint over HTTP; the
 * seam lets a future authorization lane be substituted without changing the
 * public {@link EmbedHostOptions} surface.
 *
 * @internal Contributor-only extension point; not part of the supported API.
 */
export interface HandoffProvider {
  /**
   * Exchange a validated request for a handoff code.
   *
   * @throws {@link EmbedHostError} with a stable code on any failure.
   */
  acquire(request: HandoffRequest): Promise<HandoffResult>;
}

/**
 * Configuration for {@link createEmbedHost}.
 */
export interface EmbedHostOptions {
  /**
   * Origins of the embedded Rayfin app(s) this host brokers for — the allowlist
   * a Builder configures with their app's URL origin(s).
   *
   * The same list gates both trust checks on a handoff:
   * - the **sender** — the browser-attested `event.origin` of the iframe that
   *   posts the readiness signal and the handoff request, compared exactly
   *   (scheme + host + port); a message from any other origin is ignored; and
   * - the **return origin** — the `returnOrigin` carried in the request payload,
   *   which the resulting handoff code is bound to; a request naming an origin
   *   outside this list is rejected before any network call.
   *
   * In the supported topology the embedded iframe both requests and redeems the
   * handoff, so its origin and the return origin are the same value — hence one
   * allowlist rather than two.
   */
  allowedOrigins: string[];
  /**
   * Yields the parent's delegated Entra access token. Invoked once per handoff
   * request; the returned token is never cached across requests.
   */
  getAccessToken: () => string | Promise<string>;
  /**
   * Overrides the acquisition seam. Defaults to the HTTP brokered-authorize
   * provider.
   *
   * @internal Contributor-only; not part of the supported API.
   */
  handoffProvider?: HandoffProvider;
}

/**
 * Handle returned by {@link createEmbedHost}.
 */
export interface EmbedHost {
  /**
   * Removes the parent-window message listener and stops brokering handoffs.
   * Idempotent.
   */
  dispose(): void;
}
