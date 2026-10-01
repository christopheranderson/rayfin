/**
 * Utilities for cross-platform path handling in Rayfin CLI
 */

/**
 * Normalizes a path to use forward slashes, making it consistent across platforms
 * for testing and display purposes.
 *
 * @param path - The path to normalize
 * @returns The normalized path with forward slashes
 */
export const normalizePath = (path: string): string => {
  return path.replace(/\\/g, '/');
};

/**
 * Ensures a path has a trailing slash (for directories)
 *
 * @param path - The path to ensure has a trailing slash
 * @returns The path with a trailing slash
 */
export const ensureTrailingSlash = (path: string): string => {
  const normalized = normalizePath(path);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
};

/**
 * Ensures a path does not have a trailing slash
 *
 * @param path - The path to ensure has no trailing slash
 * @returns The path without a trailing slash
 */
export const removeTrailingSlash = (path: string): string => {
  const normalized = normalizePath(path);
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

/**
 * Combines path segments with proper normalization
 *
 * @param segments - The path segments to combine
 * @returns The combined path with forward slashes
 */
export const combinePaths = (...segments: string[]): string => {
  const joined = segments.join('/');
  return normalizePath(joined.replace(/\/+/g, '/'));
};
