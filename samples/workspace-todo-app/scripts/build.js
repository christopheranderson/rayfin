/**
 * build.js — Full build pipeline for the workspace-todo-app sample.
 *
 * Steps:
 * 1. Clean existing target/ (if any)
 * 2. Run `rayfin init target -t ./template --skip-install --overwrite`
 * 3. Restore root package.json (rayfin init scaffolding sync may overwrite it)
 * 4. Rewrite SDK deps to point to local monorepo packages
 * 5. Validate outer package.json includes all inner @microsoft/rayfin-* deps
 * 6. Run npm install in target/
 * 7. Verify/create SDK symlinks in target/node_modules/
 * 8. Run npm run build in target/
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  existsSync as exists,
  symlinkSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  realpathSync,
} from 'node:fs';

const sampleRoot = resolve(import.meta.dirname, '..');
const rootPkgPath = resolve(sampleRoot, 'package.json');
const targetPath = resolve(sampleRoot, 'target');

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  const mergedOpts = { cwd: sampleRoot, ...opts };
  const result = spawnSync(cmd, {
    cwd: mergedOpts.cwd,
    shell: true,
    encoding: 'utf-8',
  });
  // Write all output to stdout so Rush sees it (and doesn't classify as warnings)
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stdout.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

// 1. Clean
run('node scripts/clean.js');

// Save root package.json before init (scaffolding sync can overwrite it)
const rootPkgBackup = readFileSync(rootPkgPath, 'utf-8');

// 2. Init from template (directory arg = target/)
run('npx rayfin init target -t ./template --skip-install --overwrite');

// 3. Restore root package.json
writeFileSync(rootPkgPath, rootPkgBackup);

// 4. Link local SDK packages (rewrites version specs to file: refs)
run('node scripts/link-local-sdk.js');

function collectDepNames(pkg) {
  const names = new Set();
  for (const depField of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = pkg[depField];
    if (!deps) continue;
    for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function getInnerWorkspaceRayfinDeps() {
  const packageJsonPaths = [resolve(targetPath, 'package.json')];
  const innerPackagesDir = resolve(targetPath, 'packages');
  if (exists(innerPackagesDir)) {
    for (const dirent of readdirSync(innerPackagesDir, {
      withFileTypes: true,
    })) {
      if (dirent.isDirectory()) {
        packageJsonPaths.push(
          resolve(innerPackagesDir, dirent.name, 'package.json')
        );
      }
    }
  }

  const rayfinDeps = new Set();
  for (const pkgPath of packageJsonPaths) {
    if (!exists(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps = collectDepNames(pkg);
    for (const depName of deps) {
      if (depName.startsWith('@microsoft/rayfin-')) rayfinDeps.add(depName);
    }
  }
  return Array.from(rayfinDeps).sort();
}

function assertOuterPackageContainsInnerRayfinDeps() {
  const outerPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
  const outerDeps = collectDepNames(outerPkg);
  const innerRayfinDeps = getInnerWorkspaceRayfinDeps();
  const missingDeps = innerRayfinDeps.filter((dep) => !outerDeps.has(dep));

  if (missingDeps.length > 0) {
    console.error(
      [
        '[error] workspace dependency validation failed.',
        '[error] Every @microsoft/rayfin-* dependency used by target workspace packages',
        `[error] must also be declared in ${rootPkgPath}.`,
        `[error] Missing in outer package.json: ${missingDeps.join(', ')}`,
      ].join('\n')
    );
    process.exit(1);
  }
}

assertOuterPackageContainsInnerRayfinDeps();

// 6. Install dependencies in target
run('npm install', { cwd: targetPath });

// 7. Verify SDK symlinks exist (npm workspace hoisting with file: refs can
//    be unreliable across npm versions — create missing symlinks manually)
const repoRoot = resolve(sampleRoot, '..', '..');
const SDK_PACKAGES = {
  '@microsoft/rayfin-cli': 'packages/tools/cli',
  '@microsoft/rayfin-core': 'packages/typescript-sdk/core',
  '@microsoft/rayfin-client': 'packages/typescript-sdk/client',
  '@microsoft/rayfin-data': 'packages/typescript-sdk/data',
  '@microsoft/rayfin-functions': 'packages/typescript-sdk/functions',
  '@microsoft/rayfin-auth-provider-fabric':
    'packages/typescript-sdk/auth-provider-fabric',
};
const nmDir = resolve(targetPath, 'node_modules', '@microsoft');
mkdirSync(nmDir, { recursive: true });
for (const [name, rel] of Object.entries(SDK_PACKAGES)) {
  const shortName = name.replace('@microsoft/', '');
  const linkPath = resolve(nmDir, shortName);
  const target = resolve(repoRoot, rel);
  if (!exists(linkPath)) {
    console.log(`Linking missing ${name} → ${target}`);
    symlinkSync(target, linkPath, 'junction');
  }
}

function listMicrosoftScope(dir) {
  const scopeDir = resolve(dir, '@microsoft');
  if (!exists(scopeDir)) return '(missing)';
  return readdirSync(scopeDir).sort().join(', ');
}

function logPackageResolution(name) {
  const shortName = name.replace('@microsoft/', '');
  const rootPath = resolve(targetPath, 'node_modules', '@microsoft', shortName);
  const frontendPath = resolve(
    targetPath,
    'packages',
    'frontend',
    'node_modules',
    '@microsoft',
    shortName
  );
  const rootExists = exists(rootPath);
  const frontendExists = exists(frontendPath);

  console.log(`[debug] ${name} root=${rootExists} frontend=${frontendExists}`);

  if (rootExists) {
    const stat = lstatSync(rootPath);
    const kind = stat.isSymbolicLink()
      ? 'symlink'
      : stat.isDirectory()
        ? 'dir'
        : 'other';
    console.log(`[debug] ${name} root kind=${kind}`);
    try {
      console.log(`[debug] ${name} root realpath=${realpathSync(rootPath)}`);
    } catch {
      console.log(`[debug] ${name} root realpath=(unresolved)`);
    }
  }
}

console.log(
  `[debug] target/node_modules/@microsoft: ${listMicrosoftScope(
    resolve(targetPath, 'node_modules')
  )}`
);
console.log(
  `[debug] target/packages/frontend/node_modules/@microsoft: ${listMicrosoftScope(
    resolve(targetPath, 'packages', 'frontend', 'node_modules')
  )}`
);
const frontendPkgPath = resolve(
  targetPath,
  'packages',
  'frontend',
  'package.json'
);
if (exists(frontendPkgPath)) {
  console.log(
    `[debug] target/packages/frontend/package.json:\n${readFileSync(
      frontendPkgPath,
      'utf-8'
    )}`
  );
} else {
  console.log('[debug] target/packages/frontend/package.json: (missing)');
}
for (const name of Object.keys(SDK_PACKAGES)) {
  logPackageResolution(name);
}

// 8. Build target
run('npm run build', { cwd: targetPath });

console.log('\n✅ workspace-todo-app build succeeded');
