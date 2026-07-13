import { RayfinClient } from '@microsoft/rayfin-client';
import type { TodoAppSchema } from '@workspace-todo-app/data';
import type { TodoFunctionsSchema } from '@workspace-todo-app/functions';
import { resolveRayfinConfig } from '@workspace-todo-app/local-dev';

/**
 * The fully-typed client for this app: data entities come from
 * `TodoAppSchema` and serverless functions from `TodoFunctionsSchema`, so
 * `client.data.*` and `client.functions.*` are both type-checked.
 */
export type AppRayfinClient = RayfinClient<TodoAppSchema, TodoFunctionsSchema>;

/**
 * A singleton service that owns the {@link AppRayfinClient} instance.
 *
 * The base URL / publishable key are resolved by `resolveRayfinConfig()` from
 * `@workspace-todo-app/local-dev`, which returns the same-origin `/.rayfin`
 * proxy prefix during local dev (so requests are transparently forwarded to the
 * backend and to a locally-running Functions host) and the absolute
 * `VITE_RAYFIN_API_URL` in a production build. The app code is identical in
 * both environments.
 */
export class RayfinClientService {
  private static instance: RayfinClientService | null = null;
  private _client: AppRayfinClient | null = null;

  private constructor() {}

  public static getInstance(): RayfinClientService {
    if (!RayfinClientService.instance) {
      RayfinClientService.instance = new RayfinClientService();
    }
    return RayfinClientService.instance;
  }

  /**
   * Construct the RayfinClient (idempotent). Safe to call multiple times.
   */
  public initialize(): AppRayfinClient {
    if (!this._client) {
      const { baseUrl, publishableKey } = resolveRayfinConfig();
      this._client = new RayfinClient<TodoAppSchema, TodoFunctionsSchema>({
        baseUrl,
        publishableKey,
        authStorage: true,
      });
    }
    return this._client;
  }

  public getClient(): AppRayfinClient {
    if (!this._client) {
      throw new Error('RayfinClient not initialized. Call initialize() first.');
    }
    return this._client;
  }

  public isInitialized(): boolean {
    return this._client !== null;
  }

  public static reset(): void {
    RayfinClientService.instance = null;
  }
}

/**
 * Convenience accessor for the initialized {@link AppRayfinClient}.
 * @throws if the client has not been initialized yet.
 */
export function getRayfinClient(): AppRayfinClient {
  return RayfinClientService.getInstance().getClient();
}
