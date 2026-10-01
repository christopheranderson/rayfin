/**
 * CLI implementation of the {@link Http} adapter.
 *
 * A thin wrapper over the global `fetch` that attaches a bearer token from
 * an {@link Auth} adapter to every request. Per the `Http` interface's
 * identity-seam note, one instance carries one identity/scope: the host
 * wires one `Http` per backend (e.g. a Fabric-scoped instance) rather than
 * multiplexing scopes through a single instance.
 *
 * Token acquisition is deferred to each call so a long-lived instance always
 * sends a fresh (cache-backed) token; {@link Auth.getToken} handles silent
 * reuse and refresh.
 */
import type {
  Auth,
  Http,
} from '@microsoft/rayfin-tools-common/_internal/adapters';

import { fabricFetch } from '../utils/http-client.js';

/**
 * Construct a Fabric-authenticated {@link Http} for the CLI host.
 *
 * @param auth - Token source for the request's `Authorization` header.
 * @param scopes - Scope set the acquired token must cover.
 */
export function createCliHttp(auth: Auth, scopes: readonly string[]): Http {
  return {
    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
      const { token } = await auth.getToken(scopes);
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return fabricFetch(input, { ...init, headers });
    },
  };
}
