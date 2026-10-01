import type {
  PasswordlessConfig,
  RayfinConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';

/**
 * Options for configuring passwordless authentication.
 */
export interface PasswordlessOptions {
  /** Whether magic link authentication is enabled. */
  magicLinkEnabled?: boolean;
  /** Magic link expiration time in minutes (default: 15). */
  expiryMinutes?: number;
}

/**
 * Options for configuring auth methods.
 */
export interface AuthOptions {
  /** Whether password-based authentication (email + password) is enabled. Default: true */
  passwordEnabled?: boolean;
  /** Passwordless authentication options (magic link, etc.). */
  passwordless?: PasswordlessOptions;
  /** Whether Fabric brokered authentication (Entra SSO) is enabled. */
  fabricEnabled?: boolean;
  /** Allowed redirect URIs for authentication callbacks (shared across all auth methods). */
  allowedRedirectUris?: string[];
}

/**
 * Creates default auth configuration settings for rayfin.yml.
 * Hidden settings (issuer, audience, validation flags, expiry) are managed internally by the backend.
 * @param enabled - Whether auth service is enabled
 * @param emailEnabled - Whether email verification is enabled (optional, only used when auth is enabled)
 * @param authOptions - Auth method options including password and passwordless settings
 * @returns Auth configuration object with defaults
 */
export function createAuthConfig(
  enabled: boolean,
  emailEnabled = false,
  authOptions?: AuthOptions
): RayfinConfig['services']['auth'] {
  if (!enabled) {
    return { enabled: false };
  }

  const config: RayfinConfig['services']['auth'] = {
    enabled: true,
    customClaims: {
      app_version: '1.0.0',
    },
    scopes: ['read:data', 'write:data'],
  };

  // Add password configuration (explicit setting for clarity)
  // Default to true if not specified for backward compatibility
  const passwordEnabled = authOptions?.passwordEnabled ?? true;
  config.password = {
    enabled: passwordEnabled,
  };

  // Default allowed redirect URIs if none provided at top level
  if (authOptions?.allowedRedirectUris === undefined) {
    config.allowedRedirectUris = ['http://localhost:5173'];
  }

  // Add passwordless configuration if magic link is enabled
  const passwordlessOptions = authOptions?.passwordless;
  if (passwordlessOptions?.magicLinkEnabled) {
    const passwordlessConfig: PasswordlessConfig = {
      magicLink: {
        enabled: true,
        expiryMinutes: passwordlessOptions.expiryMinutes ?? 15,
      },
    };
    config.passwordless = passwordlessConfig;
  }

  // Add Fabric brokered auth configuration if enabled
  if (authOptions?.fabricEnabled) {
    config.fabric = { enabled: true };
  }

  // Add top-level allowed redirect URIs
  if (
    authOptions?.allowedRedirectUris &&
    authOptions.allowedRedirectUris.length > 0
  ) {
    config.allowedRedirectUris = authOptions.allowedRedirectUris;
  }

  // Add email configuration if enabled
  if (emailEnabled) {
    config.email = {
      enabled: true,
      provider: 'smtp',
      senderName: 'Rayfin Platform',
      verificationTokenExpirationHours: 24,
      passwordResetTokenExpirationMinutes: 30,
      smtp: {
        host: 'maildev',
        port: 1025,
        senderEmail: 'noreply@rayfin.local',
        username: '',
        password: '',
        useSsl: false,
        useStartTls: false,
        webPort: 1080,
      },
    };
  }

  return config;
}

/**
 * Validation error for auth configuration.
 */
export interface AuthConfigValidationError {
  field: string;
  message: string;
}

/**
 * Validation result for auth configuration.
 */
export interface AuthConfigValidationResult {
  valid: boolean;
  errors: AuthConfigValidationError[];
  warnings: string[];
}

/**
 * Validates a URL string.
 * @param url - The URL string to validate
 * @returns True if the URL is valid, false otherwise
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if a URL uses HTTPS or is localhost.
 * @param url - The URL string to check
 * @returns True if the URL uses HTTPS or is localhost, false otherwise
 */
function isHttpsOrLocalhost(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') {
      return true;
    }
    // Allow HTTP for localhost development
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Validates auth configuration for consistency and correctness.
 * @param authConfig - The auth configuration to validate
 * @returns Validation result with errors and warnings
 */
export function validateAuthConfig(
  authConfig: RayfinConfig['services']['auth']
): AuthConfigValidationResult {
  const errors: AuthConfigValidationError[] = [];
  const warnings: string[] = [];

  if (!authConfig.enabled) {
    return { valid: true, errors, warnings };
  }

  const passwordless = authConfig.passwordless;
  const magicLink = passwordless?.magicLink;

  // Validate: require email.enabled when magic_link.enabled
  if (magicLink?.enabled && !authConfig.email?.enabled) {
    errors.push({
      field: 'services.auth.passwordless.magicLink.enabled',
      message:
        'Magic link authentication requires email to be enabled. Set services.auth.email.enabled to true.',
    });
  }

  // Validate allowed redirect URIs (top-level auth property)
  if (authConfig.allowedRedirectUris) {
    for (const uri of authConfig.allowedRedirectUris) {
      if (!isValidUrl(uri)) {
        errors.push({
          field: 'services.auth.allowedRedirectUris',
          message: `Invalid redirect URI: "${uri}". Must be a valid URL.`,
        });
      } else if (!isHttpsOrLocalhost(uri)) {
        errors.push({
          field: 'services.auth.allowedRedirectUris',
          message: `Redirect URI "${uri}" must use HTTPS for non-localhost URLs.`,
        });
      }
    }
  }

  // Validate expiry minutes is positive
  if (
    magicLink?.enabled &&
    magicLink.expiryMinutes !== undefined &&
    magicLink.expiryMinutes <= 0
  ) {
    errors.push({
      field: 'services.auth.passwordless.magicLink.expiryMinutes',
      message: 'Magic link expiry must be greater than 0 minutes.',
    });
  }

  // Warning: both password and passwordless disabled
  // Password auth is the default when no passwordless methods are enabled
  // If email is not enabled, password reset won't work either
  const passwordlessDisabled = !magicLink?.enabled;
  const emailDisabled = !authConfig.email?.enabled;

  if (passwordlessDisabled && emailDisabled) {
    warnings.push(
      'Both passwordless authentication and email are disabled. ' +
        'Users will only be able to authenticate with passwords but cannot reset forgotten passwords.'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
