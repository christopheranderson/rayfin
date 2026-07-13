export interface HealthCheckResult {
  ok: boolean;
  timestamp: string;
}

/**
 * Wraps calls to the app's Rayfin functions so the UI never touches the client
 * directly.
 */
export interface IFunctionsService {
  /** Liveness probe backed by the `healthCheck` Rayfin function. */
  healthCheck(): Promise<HealthCheckResult>;
}
