/**
 * Http adapter — authenticated `fetch`.
 *
 * A thin wrapper over the platform `fetch` so universal service clients
 * (`FabricClient`, `AzureArmClient`, …) can issue requests without knowing
 * how the host acquires tokens or configures the agent. The host's
 * implementation is responsible for attaching auth headers, proxies, and
 * retry-at-transport concerns it owns.
 *
 * The signature mirrors the web-platform `fetch` so a host can supply the
 * global `fetch` directly when no extra wiring is required.
 *
 * Identity seam: one `Http` instance carries one identity/scope — the host
 * bakes the token acquisition in. A workflow that talks to multiple backends
 * needing different scopes wires one `Http` per backend (e.g. `fabricHttp`,
 * `azureHttp` in its `Deps`) rather than multiplexing through a single
 * instance. If per-request scope selection is ever needed, surface it
 * additively (an optional field on `init` or a wrapper) — do NOT assume a
 * single global identity hardens here.
 */
export interface Http {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}
