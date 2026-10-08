// Internal HTTP route-path fragments used by the SDK's auth and functions
// clients to build request URLs. These are implementation details of the
// Rayfin backend contract; Builders interact with the typed client methods
// (for example, `auth.signIn(...)`), never these raw paths. All are tagged
// `@internal` so they are excluded from the published API reference.

/** @internal Versioned auth endpoint root (legacy unversioned removed). */
export const AUTH_V1_ENDPOINT = '/api/auth/v1';

/** @internal */
export const SIGNUP_PATH = '/signup';
/** @internal OAuth2.1 password grant. */
export const TOKEN_PATH = '/token';
/** @internal External-Entra brokered authorize endpoint (relative to {@link AUTH_V1_ENDPOINT}). */
export const BROKERED_AUTHORIZE_EXTERNAL_PATH = '/brokered/authorize/external';
/** @internal */
export const SIGNOUT_PATH = '/signout';
/** @internal */
export const SIGNOUT_ALL_PATH = '/signout-all';
/** @internal */
export const SET_USER_ROLE_PATH = '/set-user-role';
/** @internal */
export const INTROSPECT_PATH = '/introspect';
/** @internal */
export const HEALTH_PATH = '/health';
/** @internal */
export const ANONYMOUS_TOKEN_PATH = '/anonymous-token';
/** @internal */
export const JWKS_PATH = '/.well-known/jwks.json';
/** @internal Currently health returns the feature list. */
export const FEATURES_PATH = '/health';
/** @internal */
export const VERIFY_EMAIL_PATH = '/verify-email';
/** @internal */
export const RESEND_VERIFICATION_EMAIL_PATH = '/resend-verification-email';
/** @internal */
export const REQUEST_PASSWORD_RESET_PATH = '/reset-password';
/** @internal */
export const COMPLETE_PASSWORD_RESET_PATH = '/reset-password/complete';
/** @internal */
export const MAGIC_LINK_SEND_PATH = '/passwordless/send';
/** @internal */
export const MAGIC_LINK_VERIFY_PATH = '/passwordless/verify';

/** @internal Project Settings endpoint (public, no auth required). */
export const PROJECT_RUNTIME_SETTINGS_PATH = '/api/projectRuntimeSettings';

/** @internal Functions endpoint base path (callers append `/${functionName}/invoke`). */
export const FUNCTIONS_BASE_PATH = '/functions';

/**
 * @internal Default request timeout (ms) for function invocations.
 *
 * Function execution can run far longer than a typical data request, so the
 * generic 30s `ApiClient` default is too aggressive. This mirrors the
 * server-side BaaS-invoke to UDF-invoke timeout, which forwards to the Azure
 * Function with a 250s budget (Azure Functions caps HTTP-triggered execution
 * at 230s; the backend buffers to 250s). Keeping the client aligned prevents
 * the SDK from aborting an invocation the backend is still willing to serve.
 */
export const FUNCTIONS_INVOKE_TIMEOUT_MS = 250_000;

// Connector invocation endpoint (base path — callers append `/${connectorName}`
// and POST a JSON body `{ operation, input }`).
export const CONNECTOR_INVOKE_BASE_PATH = '/connector-invoke';

// Connector GraphQL endpoint base path (callers append `/${connectorName}/graphql`).
export const CONNECTOR_GRAPHQL_RUNTIME_BASE_PATH = '/connectors';
