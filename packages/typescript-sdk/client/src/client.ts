/**
 * @packageDocumentation Main entry point for the Rayfin SDK.
 * Exposes a browser-oriented RayfinClient (with full Auth support) and a
 * server/worker-oriented RayfinServerClient (no Auth, token-based auth).
 */

import { Auth, AuthStorage, type AuthOptions } from '@microsoft/rayfin-auth';
import { type EntitySchema, createDataApi } from '@microsoft/rayfin-data';
import {
  createFunctionsApi,
  type FunctionsSchema,
} from '@microsoft/rayfin-functions';
import { SdkError, NetworkError } from '@microsoft/rayfin-lib';
import { ApiClient, ApiClientConfig } from '@microsoft/rayfin-lib';

import { type RayfinRuntimeConfig } from './config';

/**
 * Auth error specific to the Rayfin SDK.
 */
export class AuthError extends SdkError {
  /**
   * @param message - Human-readable error description.
   * @param code - Optional stable error code (defaults to `'AUTH_ERROR'`).
   */
  constructor(message: string, code?: string) {
    super(message, code || 'AUTH_ERROR');
  }
}

/**
 * Configuration for the browser-oriented {@link RayfinClient}, extending the
 * base HTTP client configuration with auth-token storage options.
 */
export interface RayfinClientConfig extends ApiClientConfig {
  /**
   * Storage implementation for authentication tokens.
   * If set to true, localStorage will be used.
   * If set to false, no storage will be used.
   * You may also provide your own storage or use browser's built-in Session Storage
   */
  authStorage?: AuthStorage | boolean;
  /** When false, all storage I/O is skipped — pure in-memory session. Default: true */
  persistSession?: boolean;
  /** When false, session expiration timers are not scheduled and automatic refresh on 401 is disabled. Default: true */
  autoRefreshToken?: boolean;
  /** When false, StorageEvent listener is not registered. Default: auto-detected (true in browser with localStorage). */
  multiTabSync?: boolean;
  /** Values passed through to `resolveRayfinConfig()`'s `runtimeConfig` result when constructed via that helper (e.g. build-time `VITE_*` vars as defaults); exposed as `client.runtimeConfig`. */
  runtimeConfig?: RayfinRuntimeConfig;
}

/**
 * Configuration for the server/worker-oriented {@link RayfinServerClient}.
 * Omits the browser-only `getAccessToken` hook in favor of a supplied
 * access token.
 */
export interface RayfinServerClientConfig extends Omit<
  ApiClientConfig,
  'getAccessToken'
> {
  /** Access token (string or function) for Authorization: Bearer <token>. Use the function form to rotate per request. */
  accessToken?: string | (() => string | null);
  /** Values passed through to `resolveRayfinConfig()`'s `runtimeConfig` result when constructed via that helper (e.g. build-time env vars as defaults); exposed as `client.runtimeConfig`. */
  runtimeConfig?: RayfinRuntimeConfig;
}

/** Shared base for Rayfin clients: owns the typed data API and the underlying HTTP client. */
export abstract class RayfinClientBase<
  TSchema extends EntitySchema = Record<string, any>,
> {
  /** Typed data API for querying and mutating your entities. */
  public readonly data: ReturnType<typeof createDataApi<TSchema>>;
  protected apiClient: ApiClient;

  protected constructor(
    config: ApiClientConfig & { runtimeConfig?: RayfinRuntimeConfig }
  ) {
    // Legacy compatibility: before `useProxy` was deprecated, passing
    // `useProxy: true` without a `baseUrl` meant "route same-origin through the
    // dev-server proxy". Preserve that as `baseUrl: ''` during the deprecation
    // window so existing consumers are not broken. The ApiClient emits the
    // one-time `useProxy` deprecation warning.
    const baseUrl =
      (config.baseUrl === undefined || config.baseUrl === null) &&
      config.useProxy
        ? ''
        : config.baseUrl;

    if (baseUrl === undefined || baseUrl === null) {
      throw new SdkError(
        'SDK configuration requires a baseUrl. Pass an absolute URL to call a ' +
          "backend directly, or an empty string ('') to keep requests " +
          'same-origin so a development proxy can forward them.',
        'MISSING_BASE_URL'
      );
    }

    if (!config.publishableKey || config.publishableKey.trim() === '') {
      throw new SdkError(
        'SDK configuration requires a publishableKey for service-level authentication.',
        'MISSING_PUBLISHABLE_KEY'
      );
    }

    this.apiClient = new ApiClient({
      baseUrl: baseUrl,
      publishableKey: config.publishableKey,
      functionsBaseUrl: config.functionsBaseUrl,
      useProxy: config.useProxy,
      headers: config.headers,
      moniker: config.runtimeConfig?.itemId,
      timeout: config.timeout,
      getAccessToken: config.getAccessToken,
    });

    this.data = createDataApi<TSchema>(this.apiClient);
  }

  // Static access to custom errors for easy import by consumers
  /** SDK error classes, exposed for convenient `instanceof` checks. */
  public static readonly errors = {
    SdkError,
    AuthError,
    NetworkError,
  };
}

/**
 * Main SDK class for Rayfin.
 * This class acts as the primary interface for interacting with Rayfin services,
 * providing authentication, and GraphQL capabilities through a single entry point.
 *
 * @typeParam TSchema - Object type mapping entity names to their types
 * @example Frontend usage
 * ```typescript
 * const client = new RayfinClient<{
 *   User: User;
 *   Organization: Organization;
 * }>({
 *   baseUrl: 'http://localhost:5168',
 *   publishableKey: 'pk-Abc123-def456-GHI78'
 * });
 *
 * // Authentication operations
 * await client.auth.signUp({ email: 'user@example.com', password: 'password' });
 *
 * // GraphQL operations
 * const activeUsers = await client.User
 *   .select(['id', 'name', 'email'])
 *   .where({ isActive: true })
 *   .execute();
 * ```
 *
 * @example ALM-aware deployments — resolve runtime config, then construct
 * ```typescript
 * import { RayfinClient, resolveRayfinConfig } from '@microsoft/rayfin-client';
 *
 * const resolved = await resolveRayfinConfig({ baseUrl, publishableKey });
 * const client = new RayfinClient({ ...resolved, authStorage: true });
 * ```
 */
export class RayfinClient<
  TSchema extends EntitySchema = Record<string, any>,
  TFunctionsSchema extends FunctionsSchema = FunctionsSchema,
> extends RayfinClientBase<TSchema> {
  /** Authentication operations (sign up, sign in, sign out, session state). */
  public readonly auth: Auth;
  /** Typed, schema-aware accessors for invoking your backend functions. */
  public readonly functions: ReturnType<
    typeof createFunctionsApi<TFunctionsSchema>
  >;
  /** All resolved `rayfin.config.json` values, for apps that need more than just `baseUrl`/`publishableKey` (e.g. Fabric embed auth coordinates). */
  public readonly runtimeConfig?: RayfinRuntimeConfig;

  /**
   * Creates a browser Rayfin client and wires up authentication.
   *
   * @param config - Client configuration, including optional auth-token storage.
   */
  constructor(config: RayfinClientConfig) {
    super(config);
    this.auth = new Auth(this.apiClient, {
      storage: config.authStorage,
      persistSession: config.persistSession,
      autoRefreshToken: config.autoRefreshToken,
      multiTabSync: config.multiTabSync,
    });
    this.auth.attachToClient(this.apiClient);
    this.functions = createFunctionsApi<TFunctionsSchema>(this.apiClient);
    this.runtimeConfig = config.runtimeConfig;
  }
}

/**
 * Server / worker (Node.js) Rayfin client. Skips the browser-coupled Auth
 * module entirely — authentication is supplied via the accessToken config.
 *
 * @example
 * ```typescript
 * const client = new RayfinServerClient<{ Todo: Todo }>({
 *   baseUrl: process.env.RAYFIN_API_URL!,
 *   publishableKey: process.env.RAYFIN_PUBLISHABLE_KEY!,
 *   accessToken: () => incomingRequest.headers.authorization,
 * });
 *
 * const todos = await client.data.Todo.select(['id', 'title']).execute();
 * ```
 *
 * @example ALM-aware deployments — resolve runtime config, then construct
 * ```typescript
 * import { RayfinServerClient, resolveRayfinConfig } from '@microsoft/rayfin-client';
 *
 * // Node.js/workers have no implicit document origin, so pass an absolute
 * // configUrl to enable remote config loading.
 * const resolved = await resolveRayfinConfig(
 *   { baseUrl, publishableKey },
 *   { configUrl: `${process.env.RAYFIN_API_URL}/rayfin.config.json` }
 * );
 * const client = new RayfinServerClient({ ...resolved, accessToken });
 * ```
 */
export class RayfinServerClient<
  TSchema extends EntitySchema = Record<string, any>,
> extends RayfinClientBase<TSchema> {
  /**
   * Creates a server/worker Rayfin client using a supplied access token.
   *
   * @param config - Client configuration, including the access token (string or
   * function form for per-request rotation).
   */
  /** All resolved `rayfin.config.json` values, for callers that need more than just `baseUrl`/`publishableKey`. */
  public readonly runtimeConfig?: RayfinRuntimeConfig;

  constructor(config: RayfinServerClientConfig) {
    super(config);
    if (config.accessToken !== undefined) {
      const tokenFn =
        typeof config.accessToken === 'function'
          ? config.accessToken
          : () => config.accessToken as string;
      this.apiClient.setAccessTokenCallback(tokenFn);
    }
    this.runtimeConfig = config.runtimeConfig;
  }
}

// Default export remains the browser client for backward compatibility.
export default RayfinClient;
