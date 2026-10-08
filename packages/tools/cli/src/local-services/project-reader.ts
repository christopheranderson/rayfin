import { loadRayfinConfig } from '../utils/config-utils.js';
import { findRayfinProjectRoot } from '../utils/project-utils.js';

/** Read project facts through the CLI's filesystem-backed configuration helpers. @internal */
export async function readProject(path: string) {
  let projectRoot: string;
  try {
    projectRoot = findRayfinProjectRoot(path, { silent: true });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Could not find rayfin project root')
    )
      return null;
    throw error;
  }
  const config = loadRayfinConfig(projectRoot, { silent: true });
  return config
    ? { projectRoot, id: config.id, services: config.services }
    : null;
}
