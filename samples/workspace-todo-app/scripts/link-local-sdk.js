/**
 * link-local-sdk.js — Rewrite @microsoft/rayfin-* dependencies in target/
 * to use file: references pointing to the local Rush-managed SDK packages.
 * This allows the template output to resolve against the monorepo's source
 * without publishing SDK packages.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const targetDir = resolve(import.meta.dirname, '..', 'target');
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

const SDK_PACKAGE_MAP = {
  '@microsoft/rayfin-cli': 'packages/tools/cli',
  '@microsoft/rayfin-core': 'packages/typescript-sdk/core',
  '@microsoft/rayfin-client': 'packages/typescript-sdk/client',
  '@microsoft/rayfin-data': 'packages/typescript-sdk/data',
  '@microsoft/rayfin-functions': 'packages/typescript-sdk/functions',
  '@microsoft/rayfin-auth-provider-fabric':
    'packages/typescript-sdk/auth-provider-fabric',
};

function rewritePackageJson(pkgPath) {
  if (!existsSync(pkgPath)) return false;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  let modified = false;

  for (const depField of ['dependencies', 'devDependencies']) {
    if (!pkg[depField]) continue;
    for (const [name, localPath] of Object.entries(SDK_PACKAGE_MAP)) {
      if (pkg[depField][name]) {
        const absolutePath = resolve(repoRoot, localPath);
        pkg[depField][name] = `file:${absolutePath}`;
        modified = true;
      }
    }
  }

  if (modified) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  return modified;
}

// Rewrite root target/package.json
const rootPkg = join(targetDir, 'package.json');
if (rewritePackageJson(rootPkg)) {
  console.log('Rewrote SDK refs in target/package.json');
}

// Rewrite each sub-package
const packagesDir = join(targetDir, 'packages');
if (existsSync(packagesDir)) {
  for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
    if (dir.isDirectory()) {
      const subPkg = join(packagesDir, dir.name, 'package.json');
      if (rewritePackageJson(subPkg)) {
        console.log(
          `Rewrote SDK refs in target/packages/${dir.name}/package.json`
        );
      }
    }
  }
}

console.log('SDK linking complete');
