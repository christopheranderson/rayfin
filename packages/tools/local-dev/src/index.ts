/**
 * Same-origin base URL used for local Rayfin function invocations.
 *
 * The Rayfin Vite adapter owns this path while the development server is
 * running. Production builds continue to invoke functions through the
 * configured Rayfin backend.
 */
export const RAYFIN_LOCAL_FUNCTIONS_BASE_URL = '/.rayfin';

declare const __RAYFIN_LOCAL_FUNCTIONS_PROXY__: boolean | undefined;
declare const __RAYFIN_LOCAL_STATIC_ACCESS__: RayfinStaticAccess | undefined;
declare const __RAYFIN_LOCAL_AUTO_LOGIN__: boolean | undefined;

/** Who can load the app's hosted assets, as declared in `rayfin/rayfin.yml`. */
export type RayfinStaticAccess = 'protected' | 'public';

/**
 * A Rayfin token response obtained from this backend's brokered-token
 * exchange, ready to install directly with `signInWithBrokeredToken()` from
 * `@microsoft/rayfin-auth-provider-fabric`. Shape matches `TokenResponse`
 * from `@microsoft/rayfin-auth`, duplicated here so this dev-only package
 * does not depend on the auth SDK.
 */
export interface RayfinLocalSessionToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken?: string;
  scope?: string;
}

/**
 * Resolve the optional Functions base URL passed to `RayfinClient`.
 *
 * @returns The absolute same-origin proxy URL when the Vite adapter registered
 * local Functions routing; otherwise `undefined` so the SDK uses the deployed
 * Rayfin route.
 *
 * @example
 * ```ts
 * const functionsBaseUrl = resolveRayfinFunctionsBaseUrl();
 * ```
 */
export function resolveRayfinFunctionsBaseUrl(): string | undefined {
  const proxyRegistered =
    typeof __RAYFIN_LOCAL_FUNCTIONS_PROXY__ !== 'undefined' &&
    __RAYFIN_LOCAL_FUNCTIONS_PROXY__ === true;
  const origin = globalThis.location?.origin;
  if (!proxyRegistered || !origin || origin === 'null') return undefined;

  return new URL(RAYFIN_LOCAL_FUNCTIONS_BASE_URL, origin).href;
}

/**
 * Read the static-hosting posture discovered by the Vite development adapter.
 *
 * @returns The configured local access mode, or `undefined` outside a Vite
 * development server or when the project has not declared one.
 */
export function getRayfinLocalStaticAccess(): RayfinStaticAccess | undefined {
  if (typeof __RAYFIN_LOCAL_STATIC_ACCESS__ === 'undefined') return undefined;
  return __RAYFIN_LOCAL_STATIC_ACCESS__;
}

/**
 * Determine whether local development should seed authentication from Azure
 * CLI credentials.
 *
 * Protected sites always enable this behavior. Public sites enable it only
 * when the Vite adapter's `autoLogin` option is set.
 *
 * @returns `true` when local automatic sign-in is active.
 */
export function isRayfinLocalAutoLoginEnabled(): boolean {
  return (
    typeof __RAYFIN_LOCAL_AUTO_LOGIN__ !== 'undefined' &&
    __RAYFIN_LOCAL_AUTO_LOGIN__ === true
  );
}

/**
 * Request the Rayfin token response obtained by the local Vite adapter's
 * brokered-token exchange.
 *
 * The adapter acquires a delegated Entra token via the Rayfin CLI's own
 * authentication module (reusing an existing `rayfin login` session, or
 * triggering its usual interactive sign-in) and exchanges it against the
 * local backend itself, in Node -- so the exchange can reach a plain-HTTP
 * local backend that `signInWithEntraToken()`'s browser-side HTTPS
 * requirement would reject. Install the result directly with
 * `signInWithBrokeredToken()` from `@microsoft/rayfin-auth-provider-fabric`.
 *
 * @returns The token response when local automatic sign-in is active, or
 * `undefined` when the adapter is inactive.
 * @throws An actionable error when the Entra sign-in or backend exchange fails.
 */
export async function fetchRayfinLocalSessionToken(): Promise<
  RayfinLocalSessionToken | undefined
> {
  if (!isRayfinLocalAutoLoginEnabled()) return undefined;

  const response = await fetch('/.rayfin/dev/session-token', {
    headers: { accept: 'application/json' },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = readString(body, 'error') ?? 'Local sign-in failed.';
    const hint = readString(body, 'hint');
    throw new Error(hint ? `${error} ${hint}` : error);
  }

  const accessToken = readString(body, 'accessToken');
  const tokenType = readString(body, 'tokenType');
  const expiresIn = readNumber(body, 'expiresIn');
  if (!accessToken || !tokenType || expiresIn === undefined) {
    throw new Error(
      'The local sign-in endpoint returned an invalid token response.'
    );
  }
  return {
    accessToken,
    tokenType,
    expiresIn,
    refreshToken: readString(body, 'refreshToken'),
    scope: readString(body, 'scope'),
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' && property.trim() ? property : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'number' && Number.isFinite(property)
    ? property
    : undefined;
}
