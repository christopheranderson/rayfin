/**
 * PKCE (Proof Key for Code Exchange) utilities for secure authorization flows.
 * Implements RFC 7636 using the Web Crypto API for cryptographic operations.
 */

/**
 * Generates a cryptographically random code verifier for PKCE.
 * The verifier is a Base64URL-encoded string of 32 random bytes (43 characters).
 *
 * @returns A random code verifier string.
 * @throws `Error` - If cryptographic random generation fails (requires secure context/HTTPS).
 *
 * @example
 * ```typescript
 * const verifier = generateCodeVerifier();
 * // e.g., "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
 * ```
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  try {
    crypto.getRandomValues(array);
  } catch (error) {
    throw new Error(
      'Cryptographic random generation failed. Ensure you are using a secure context (HTTPS).'
    );
  }
  return base64UrlEncode(array);
}

/**
 * Generates a code challenge from a code verifier using SHA-256.
 * The challenge is the Base64URL-encoded SHA-256 hash of the verifier.
 *
 * @param verifier - The code verifier to hash.
 * @returns A promise that resolves with the code challenge string.
 *
 * @example
 * ```typescript
 * const verifier = generateCodeVerifier();
 * const challenge = await generateCodeChallenge(verifier);
 * // Send challenge to server, keep verifier secret
 * ```
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Generates a cryptographically random state parameter for OAuth flows.
 * The state is a Base64URL-encoded string of 16 random bytes (22 characters).
 *
 * Used to prevent CSRF attacks and to correlate requests with responses.
 *
 * @returns A random state string.
 * @throws `Error` - If cryptographic random generation fails (requires secure context/HTTPS).
 *
 * @example
 * ```typescript
 * const state = generateState();
 * // e.g., "xyzzy123ABC_def-GHI"
 * ```
 */
export function generateState(): string {
  const array = new Uint8Array(16);
  try {
    crypto.getRandomValues(array);
  } catch (error) {
    throw new Error(
      'Cryptographic random generation failed. Ensure you are using a secure context (HTTPS).'
    );
  }
  return base64UrlEncode(array);
}

/**
 * Encodes a Uint8Array to a Base64URL string (no padding).
 * This is the URL-safe variant of Base64 per RFC 4648 Section 5.
 *
 * @param buffer - The bytes to encode.
 * @returns The Base64URL-encoded string.
 */
function base64UrlEncode(buffer: Uint8Array): string {
  // Convert to binary string
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  // Base64 encode
  const base64 = btoa(binary);
  // Convert to Base64URL (replace + with -, / with _, remove padding)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
