import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function findWorkspacePackageJsonFiles(directory) {
  const rootManifestPath = join(directory, 'package.json');
  const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'));
  const workspacePatterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : (rootManifest.workspaces?.packages ?? []);

  if (!workspacePatterns.includes('packages/*')) {
    throw new Error(
      `${rootManifestPath} must declare the packages/* workspace`
    );
  }

  const packagesDirectory = join(directory, 'packages');
  const memberManifestPaths = readdirSync(packagesDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDirectory, entry.name, 'package.json'))
    .filter((manifestPath) => existsSync(manifestPath));

  return [rootManifestPath, ...memberManifestPaths].sort();
}
