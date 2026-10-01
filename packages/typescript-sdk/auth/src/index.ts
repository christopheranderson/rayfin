// Re-export the main Auth class and storage interface
export { Auth, type AuthStorage, type AuthOptions } from './Auth';

// Re-export AuthApi for companion provider packages
export { AuthApi } from './AuthApi';

// Re-export all types
export type {
  SignUpCredentials,
  SignUpResponse,
  PasswordGrantCredentials,
  TokenResponse,
  User,
  Session,
  OpaqueSession,
  SignOutAllResponse,
  JwksResponse,
  JsonWebKey,
  AuthEvent,
  PasswordResetRequest,
  PasswordResetResponse,
  ResendVerificationEmailRequest,
  ResendVerificationEmailResponse,
  CompletePasswordResetRequest,
  EmailVerificationResponse,
  // Magic link types
  MagicLinkOptions,
  MagicLinkResult,
  MagicLinkCallbackResult,
  PkceState,
  MagicLinkRequest,
  MagicLinkResponse,
  VerificationCodeExchangeRequest,
  // Auth settings discovery types
  AuthSettingsConfig,
  AuthMethod,
} from './types';

// Re-export PKCE utilities for advanced use cases
export {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from './pkce';

// Re-export role utilities
export type { RayfinUserRole } from './roles';
export { isValidRole, getDefaultRole } from './roles';

// Default export for convenience
export { Auth as default } from './Auth';
