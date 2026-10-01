/**
 * Endpoint configuration for the direct execution paths.
 *
 * Ported from the Lyra `app-data-cli-proxy` package, which kept endpoints in
 * one place so sovereign clouds and pre-production rings could be reached
 * without callers rewriting URLs at each call site.
 */

/** Endpoint URLs for Fabric APIs. */
export interface FabricEndpoints {
  /** Fabric REST API base URL, including the version segment. */
  fabricApi: string;
}

/**
 * Built-in production endpoints.
 *
 * Deliberately the only preset shipped in the package: a template that picks up
 * this default must point at production, and anything else (daily, MSIT, a
 * sovereign cloud) is supplied explicitly by the harness or app configuration.
 */
export const DEFAULT_ENDPOINTS: FabricEndpoints = {
  fabricApi: 'https://api.fabric.microsoft.com/v1',
};

/**
 * Default public Power BI REST base URL, derived from
 * {@link DEFAULT_ENDPOINTS}.
 */
export const DEFAULT_POWER_BI_BASE_URL = 'https://api.powerbi.com/v1.0/myorg';

/**
 * Derive the Power BI-compatible base URL from a Fabric API origin.
 *
 * The DAX endpoints live under the Power BI REST surface (`/v1.0/myorg`) rather
 * than the Fabric one (`/v1`), but both are served from the same environment.
 * Rewriting the version segment keeps a single `fabricApi` setting authoritative
 * for an environment instead of forcing callers to configure two URLs that must
 * be kept consistent.
 *
 * @param endpoints - Endpoint configuration. Defaults to
 *   {@link DEFAULT_ENDPOINTS}.
 * @returns The Power BI REST base URL, without a trailing slash.
 */
export function derivePowerBiBaseUrl(
  endpoints: FabricEndpoints = DEFAULT_ENDPOINTS
): string {
  return endpoints.fabricApi.replace(/\/v1\/?$/, '/v1.0/myorg');
}
