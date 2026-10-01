import { resolve } from 'node:path';

export const sampleRoot = resolve(import.meta.dirname, '..');
export const repoRoot = resolve(sampleRoot, '..', '..');
export const targetDir = resolve(sampleRoot, 'target');

export const localSdkPackages = {
  '@microsoft/rayfin-auth': 'packages/typescript-sdk/auth',
  '@microsoft/rayfin-auth-provider-fabric':
    'packages/typescript-sdk/auth-provider-fabric',
  '@microsoft/rayfin-cli': 'packages/tools/cli',
  '@microsoft/rayfin-client': 'packages/typescript-sdk/client',
  '@microsoft/rayfin-core': 'packages/typescript-sdk/core',
  '@microsoft/rayfin-data': 'packages/typescript-sdk/data',
  '@microsoft/rayfin-guide': 'packages/guide',
  '@microsoft/rayfin-lib': 'packages/typescript-sdk/lib',
  '@microsoft/rayfin-local-dev': 'packages/tools/local-dev',
};

export function localPackageSpec(packageName) {
  const relativePath = localSdkPackages[packageName];
  if (!relativePath) {
    throw new Error(`No repository-local package mapping for ${packageName}`);
  }
  return `file:${resolve(repoRoot, relativePath)}`;
}
