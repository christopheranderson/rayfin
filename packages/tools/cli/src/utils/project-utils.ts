import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

/**
 * Utilities for Rayfin project discovery and management
 */

/**
 * Options for {@link findRayfinProjectRoot}.
 */
export interface FindRayfinProjectRootOptions {
  /** Whether to log debug information during the search. */
  verbose?: boolean;
  /** Whether to suppress all log output (overrides verbose). */
  silent?: boolean;
}

/**
 * Finds the Rayfin project root by traversing upwards from the current working directory
 * until it finds a directory containing a `rayfin/rayfin.yml` file.
 *
 * @param startPath - The path to start searching from (defaults to current working directory)
 * @param options - Options for the search behavior
 * @returns The absolute path to the Rayfin project root
 * @throws `Error` if the Rayfin project root cannot be found
 */
export const findRayfinProjectRoot = (
  startPath: string = process.cwd(),
  options: FindRayfinProjectRootOptions = {}
): string => {
  const { verbose = false, silent = false } = options;
  let currentPath = resolve(startPath);
  const searchedPaths: string[] = [];

  if (verbose && !silent) {
    console.log(
      `🔍 Searching for Rayfin project root starting from: ${startPath}`
    );
  }

  while (true) {
    const rayfinConfigPath = resolve(currentPath, 'rayfin', 'rayfin.yml');
    searchedPaths.push(currentPath);

    if (verbose && !silent) {
      console.log(`   Checking: ${currentPath}`);
    }

    if (existsSync(rayfinConfigPath)) {
      if (!silent) {
        console.log(`👀 Found Rayfin project root: ${currentPath}`);
      }
      if (verbose && !silent) {
        console.log(`📄 Config file: ${rayfinConfigPath}`);
      }
      return currentPath;
    }

    const parentPath = dirname(currentPath);

    // If we've reached the root of the filesystem, stop searching
    if (parentPath === currentPath) {
      const errorMessage = `Could not find Rayfin project root. No 'rayfin/rayfin.yml' file found in '${startPath}' or any of its parent directories.`;

      if (verbose) {
        console.error(`❌ ${errorMessage}`);
        console.error(`🔍 Searched paths:`);
        searchedPaths.forEach((path) => console.error(`   - ${path}`));
      }

      throw new Error(errorMessage);
    }

    currentPath = parentPath;
  }
};

/**
 * Finds the Rayfin project root with verbose logging enabled by default.
 * This is a convenience function for CLI commands that want to show the search process.
 *
 * @param startPath - The path to start searching from (defaults to current working directory)
 * @returns The absolute path to the Rayfin project root
 * @throws `Error` if the Rayfin project root cannot be found
 */
export const findRayfinProjectRootVerbose = (
  startPath: string = process.cwd()
): string => {
  return findRayfinProjectRoot(startPath, { verbose: true });
};
