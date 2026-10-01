import { randomBytes } from 'crypto';

/**
 * Generates a cryptographically secure random string for use as secrets or keys
 *
 * @param length - The desired length of the string (default: 64)
 * @param encoding - The encoding to use ('hex', 'base64', or 'base64url') (default: 'base64')
 * @returns A random string of the specified length and encoding
 */
export const generateSecureToken = (
  length = 64,
  encoding: 'hex' | 'base64' | 'base64url' = 'base64'
): string => {
  // Calculate the number of bytes needed based on the encoding and desired length
  let bytesNeeded: number;

  // Different encodings have different character lengths per byte
  switch (encoding) {
    case 'hex': // Each byte becomes 2 hex characters
      bytesNeeded = Math.ceil(length / 2);
      break;
    case 'base64': // Each 3 bytes becomes 4 base64 characters
    case 'base64url':
      bytesNeeded = Math.ceil(length * 0.75);
      break;
    default:
      throw new Error(`Unsupported encoding: ${encoding}`);
  }

  // Generate random bytes
  const bytes = randomBytes(bytesNeeded);

  // Convert to the desired encoding
  let result: string;
  switch (encoding) {
    case 'hex':
      result = bytes.toString('hex');
      break;
    case 'base64':
      result = bytes.toString('base64');
      break;
    case 'base64url':
      result = bytes.toString('base64url');
      break;
    default:
      throw new Error(`Unsupported encoding: ${encoding}`);
  }

  // Trim to exact length if needed
  return result.slice(0, length);
};
