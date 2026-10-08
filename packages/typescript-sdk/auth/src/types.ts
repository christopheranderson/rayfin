/**
 * Credentials for user sign up.
 * After signup, clients must call signIn() to obtain an access token.
 */
export interface SignUpCredentials {
  /** The user's email address. */
  email: string;
  /** The user's chosen password. */
  password: string;
}

/**
 * Credentials for password grant token issuance (ROPC authentication).
 */
export interface PasswordGrantCredentials {
  /** The user's email address. */
  email: string;
  /** The user's password. */
  password: string;
}

/**
 * Response from the /signup endpoint.
 * Matches backend SignUpResponse model.
 *
 * Note: No token is issued at signup. Clients must call signIn() with
 * grant_type=password to obtain an access token.
 */
export interface SignUpResponse {
  /** The unique identifier of the newly created user. */
  userId: string;
  /** The email address the user registered with. */
  email: string;
  /** The role assigned to the user (default: `"Authenticated"`). */
  role: string;
  /** When the user was created, as an ISO 8601 timestamp. */
  createdAt: string;
  /** Whether the user's email has been verified. */
  emailVerified: boolean;
  /** When the email was verified (ISO 8601), or `null` if not yet verified. */
  emailVerifiedAt: string | null;
}

/**
 * OAuth 2.1 token response per RFC 6749.
 * Returned by the /token endpoint for all grant types.
 * Matches backend TokenResponse model.
 */
export interface TokenResponse {
  /** The JWT access token (signed with asymmetric keys). */
  accessToken: string;
  /** The token type; always `"Bearer"`. */
  tokenType: string;
  /** Access token lifetime in seconds (not milliseconds). */
  expiresIn: number;
  /** The revolving refresh token, when issued. */
  refreshToken?: string | null;
  /** Space-separated list of granted scopes, when present. */
  scope?: string | null;
}

/**
 * Represents a user object.
 */
export interface User {
  /** The unique identifier of the user. */
  id: string;
  /** The user's email address. */
  email: string;
  /** The user's assigned role, when known. */
  role?: string;
  /** Whether the user's email has been verified. */
  emailVerified?: boolean;
  /** When the email was verified (ISO 8601), or `null` if not yet verified. */
  emailVerifiedAt?: string | null;
}

/**
 * Represents token information.
 */
export interface TokenInfo {
  /** The current access token. */
  accessToken: string;
  /** The refresh token, when issued. */
  refreshToken?: string | null;
  /** Access token lifetime in seconds. */
  expiresIn?: number;
}

/**
 * Represents an authenticated session, containing user information and tokens.
 */
export interface Session {
  /** The authenticated user. */
  user: User;
  /** The current access token. */
  accessToken: string;
  /** The current refresh token, when available. */
  refreshToken?: string | null;
  /** When the access token expires. */
  expiresAt?: Date;
  /** The user's role for the session, when known. */
  role?: string;
}

/**
 * Public opaque session surface returned to app code.
 * Raw tokens are concealed internally by the Auth SDK.
 */
export interface OpaqueSession {
  /** The authenticated user, or `null` when signed out. */
  user: User | null;
  /** The user's role for the session, when known. */
  role?: string;
  /** When the access token expires. */
  expiresAt?: Date;
  /** Whether a user is currently authenticated. */
  isAuthenticated: boolean;
  /** Whether the current session is an anonymous session. */
  isAnonymous: boolean;
}

/**
 * Response from the signout-all endpoint.
 * Indicates how many sessions were invalidated.
 */
export interface SignOutAllResponse {
  /** Number of sessions that were revoked. */
  count: number;
}

/**
 * JSON Web Key (JWK) object per RFC 7517.
 * Represents a cryptographic key in JSON format.
 */
export interface JsonWebKey {
  /** Key type (for example, `"RSA"` or `"EC"`). */
  kty: string;
  /** Intended public key use (for example, `"sig"` for signature). */
  use?: string;
  /** Key ID used for key rotation. */
  kid?: string;
  /** Algorithm the key is used with (for example, `"RS256"` or `"ES256"`). */
  alg?: string;

  /** RSA modulus (Base64urlUInt-encoded). */
  n?: string;
  /** RSA exponent (Base64urlUInt-encoded). */
  e?: string;

  /** Elliptic-curve name (for example, `"P-256"`). */
  crv?: string;
  /** Elliptic-curve x coordinate (Base64urlUInt-encoded). */
  x?: string;
  /** Elliptic-curve y coordinate (Base64urlUInt-encoded). */
  y?: string;

  /** Additional, provider-specific JWK properties. */
  [key: string]: unknown;
}

/**
 * JWKS (JSON Web Key Set) response per RFC 7517.
 * Contains public keys for JWT signature verification.
 */
export interface JwksResponse {
  /** The set of public keys used for JWT signature verification. */
  keys: JsonWebKey[];
}

/** Auth event names emitted by the SDK */
export type AuthEvent =
  | 'AUTH_SIGNUP' // User successfully registered
  | 'AUTH_LOGIN' // User successfully authenticated
  | 'AUTH_LOGOUT' // User signed out
  | 'AUTH_REFRESH' // Access token refreshed
  | 'AUTH_SESSION_EXPIRED' // Session expired
  | 'AUTH_EMAIL_VERIFIED' // Email verified successfully
  | 'AUTH_VERIFICATION_EMAIL_RESENT' // Verification email resent
  | 'AUTH_PASSWORD_RESET_REQUESTED' // Password reset requested
  | 'AUTH_PASSWORD_RESET_COMPLETED' // Password reset completed
  | 'AUTH_MAGIC_LINK_SENT' // Magic link email sent
  | 'AUTH_MAGIC_LINK_ERROR'; // Magic link flow error

/**
 * Request payload for password reset.
 */
export interface PasswordResetRequest {
  /** The email address of the account to reset. */
  email: string;
}

/**
 * Response from password reset request.
 */
export interface PasswordResetResponse {
  /** Whether the reset request was accepted. */
  success: boolean;
  /** A human-readable status message. */
  message: string;
}

/**
 * Request payload for resending email verification.
 */
export interface ResendVerificationEmailRequest {
  /** The email address to resend verification to. */
  email: string;
}

/**
 * Response from resend verification email request.
 */
export interface ResendVerificationEmailResponse {
  /** Whether the resend request was accepted. */
  success: boolean;
  /** A human-readable status message. */
  message: string;
}

/**
 * Request payload for completing password reset.
 */
export interface CompletePasswordResetRequest {
  /** The password-reset token issued to the user. */
  token: string;
  /** The new password to set. */
  newPassword: string;
}

/**
 * Response from email verification.
 */
export interface EmailVerificationResponse {
  /** Whether the email was successfully verified. */
  success: boolean;
  /** A human-readable status message. */
  message: string;
  /** An optional title for display. */
  title?: string;
}

// =============================================================================
// Magic Link / Passwordless Authentication Types
// =============================================================================

/**
 * Options for initiating a magic link authentication flow.
 */
export interface MagicLinkOptions {
  /** The email address to send the magic link to. */
  email: string;
  /** The URL to redirect to after successful authentication. */
  redirectUri: string;
}

/**
 * Result from initiating a magic link request.
 * Contains the state parameter needed to correlate the callback.
 */
export interface MagicLinkResult {
  /** Whether the magic link was sent successfully. */
  success: boolean;
  /** The state parameter for correlating the callback (stored in localStorage for cross-tab support). */
  state: string;
  /** Optional message from the server. */
  message?: string;
}

/**
 * Result from handling a magic link callback.
 */
export interface MagicLinkCallbackResult {
  /** Whether the authentication was successful. */
  success: boolean;
  /** The authenticated session if successful. */
  session?: OpaqueSession;
  /** Error message if authentication failed. */
  error?: string;
  /** Error code if authentication failed. */
  errorCode?: string;
}

/**
 * PKCE state stored in localStorage during magic link flow.
 * Uses localStorage instead of sessionStorage to support cross-tab flows
 * (e.g., user clicks magic link in email which opens in a new tab).
 * Keyed by state parameter to support concurrent requests.
 */
export interface PkceState {
  /** The code verifier for PKCE exchange. */
  codeVerifier: string;
  /** The redirect URI that was used when sending the magic link. */
  redirectUri: string;
  /** When this state was created (for cleanup purposes). */
  createdAt: number;
}

/**
 * Request payload for sending a magic link (matches backend MagicLinkRequest).
 */
export interface MagicLinkRequest {
  /** Email address to send magic link to. */
  email: string;
  /** PKCE code challenge (SHA-256 hash of code verifier). */
  codeChallenge: string;
  /** State parameter for CSRF protection and flow correlation. */
  state: string;
  /** Redirect URI after authentication. */
  redirectUri: string;
}

/**
 * Response from magic link send endpoint.
 */
export interface MagicLinkResponse {
  /** Whether the magic link was sent successfully. */
  success: boolean;
  /** Optional message (e.g., "Magic link sent to email"). */
  message?: string;
}

/**
 * Request payload for exchanging a verification code for tokens.
 * Used in the magic link callback flow.
 */
export interface VerificationCodeExchangeRequest {
  /** The verification code from the magic link callback URL. */
  verificationCode: string;
  /** The PKCE code verifier (stored during sendMagicLink). */
  codeVerifier: string;
  /** The redirect URI (must match what was sent with sendMagicLink). */
  redirectUri: string;
  /**
   * Optional code type discriminator.
   * When set to `'fabric_handoff'`, indicates a Fabric brokered auth exchange.
   * Omit for standard magic link verification code exchanges.
   */
  codeType?: string;
}

// =============================================================================
// Auth Settings / Discovery Types
// =============================================================================

/**
 * Auth settings configuration returned by getAuthSettings().
 * Derived from project runtime settings endpoint.
 * Use this to dynamically configure UI based on enabled auth methods.
 */
export interface AuthSettingsConfig {
  /** Overall auth service enabled status */
  enabled: boolean;

  /** Password-based authentication settings (email + password) */
  password: {
    /** Whether password-based authentication is enabled */
    enabled: boolean;
  };

  /** Passwordless authentication settings */
  passwordless: {
    /** Magic link via email */
    magicLink: {
      /** Whether magic link authentication is enabled */
      enabled: boolean;
    };
    // Future: sms, webauthn, etc.
  };

  /** Fabric brokered auth settings — present when fabric auth is enabled */
  fabric?: {
    /** Whether Fabric brokered authentication is enabled */
    enabled: boolean;
  };

  /** Available sign-in methods for UI rendering */
  availableMethods: AuthMethod[];
}

/**
 * Authentication methods supported by Rayfin.
 */
export type AuthMethod = 'password' | 'magiclink' | 'fabric';
