/**
 * Connection details for a single Fabric endpoint.
 */
export interface Endpoint {
  /** Endpoint-specific connection string, if provided by the host. */
  connectionString: string;
  /** Endpoint-specific access token, if provided by the host. */
  accessToken: string;
}

/**
 * Host-provided Fabric item metadata used by data-connection parameters.
 */
export class FabricItem {
  public readonly aliasName: string;
  public readonly endpoints: ReadonlyMap<string, Endpoint>;

  /**
   * Create a Fabric item wrapper from host binding data.
   *
   * @param aliasName - The configured alias for the data connection.
   * @param endpoints - Available endpoints keyed by endpoint name.
   */
  constructor(aliasName: string, endpoints: ReadonlyMap<string, Endpoint>) {
    this.aliasName = aliasName;
    this.endpoints = endpoints;
  }

  /**
   * Get an access token from the first available endpoint.
   *
   * @returns A token string suitable for endpoint authentication.
   * @throws Error if no endpoint token is available.
   */
  public getAccessToken(): string {
    const first = this.endpoints.values().next();
    if (first.done) {
      throw new Error(
        `FabricItem '${this.aliasName}' has no endpoints with an access token.`
      );
    }
    return first.value.accessToken;
  }
}
