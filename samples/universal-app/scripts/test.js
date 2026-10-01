import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { repoRoot, sampleRoot, targetDir } from './local-sdk-packages.js';
import {
  assertTemplateUnchanged,
  snapshotTemplate,
} from './template-snapshot.js';

const templateDir = resolve(sampleRoot, 'template');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  console.log(`PASS: ${message}`);
}

function run(command) {
  console.log(`\n> ${command}`);
  const result = spawnSync(command, {
    cwd: targetDir,
    shell: true,
    encoding: 'utf8',
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stdout.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Command failed with exit code ${result.status}: ${command}`
    );
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readZipEntries(path) {
  const archive = readFileSync(path);
  const entries = new Map();
  let offset = 0;

  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const compressionMethod = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive
      .subarray(nameStart, dataStart - extraLength)
      .toString();
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const contents =
      compressionMethod === 8 ? inflateRawSync(compressed) : compressed;

    entries.set(name, contents);
    offset = dataStart + compressedSize;
  }

  return entries;
}

assert(existsSync(targetDir), 'target/ exists');
assert(existsSync(resolve(targetDir, 'node_modules')), 'target install exists');

const templateManifest = readJson(resolve(templateDir, 'package.json'));
const targetManifest = readJson(resolve(targetDir, 'package.json'));
assert(
  templateManifest.scripts.build === targetManifest.scripts.build,
  'target preserves the inner build command'
);
assert(
  targetManifest.name === 'target',
  'only the root app name is customized'
);
assert(
  targetManifest.template?.name === 'universal-app',
  'Universal App template identity is preserved'
);
assert(
  JSON.stringify(targetManifest.workspaces) === JSON.stringify(['packages/*']),
  'target declares the packages/* npm workspace'
);

const expectedPackages = {
  frontend: '@rayfin-app/frontend',
  data: '@rayfin-app/data',
  shared: '@rayfin-app/shared',
};
for (const [directory, packageName] of Object.entries(expectedPackages)) {
  const packageDir = resolve(targetDir, 'packages', directory);
  const manifest = readJson(resolve(packageDir, 'package.json'));
  assert(manifest.name === packageName, `${packageName} keeps its stable name`);
  assert(
    existsSync(resolve(packageDir, 'dist')),
    `${packageName} build output exists`
  );
}
assert(
  !existsSync(resolve(targetDir, 'packages', 'functions')),
  'functions package remains absent'
);

const dataManifest = readJson(resolve(targetDir, 'packages/data/package.json'));
assert(
  dataManifest.exports?.['.']?.import === './dist/index.js',
  'data package exports its built discovery entry point'
);

const sharedManifest = readJson(
  resolve(targetDir, 'packages/shared/package.json')
);
assert(
  dataManifest.dependencies?.['@rayfin-app/shared'] === '*' &&
    sharedManifest.name === '@rayfin-app/shared',
  'local workspace dependencies keep registry-compatible * ranges'
);

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
for (const directory of [
  '.',
  'packages/frontend',
  'packages/data',
  'packages/shared',
]) {
  const manifest = readJson(resolve(templateDir, directory, 'package.json'));
  for (const dependencyField of dependencyFields) {
    for (const [dependencyName, dependencySpec] of Object.entries(
      manifest[dependencyField] ?? {}
    )) {
      assert(
        !dependencySpec.startsWith('workspace:') &&
          !dependencySpec.startsWith('file:'),
        `${directory}/${dependencyName} is distributable`
      );
      if (dependencyName.startsWith('@microsoft/rayfin-')) {
        assert(
          dependencySpec === '^1.36.0-alpha',
          `${directory}/${dependencyName} uses the supported published range`
        );
      }
      if (dependencyName.startsWith('@rayfin-app/')) {
        assert(
          dependencySpec === '*',
          `${directory}/${dependencyName} uses a local * range`
        );
      }
    }
  }
}

const frontendTsConfig = readJson(
  resolve(templateDir, 'packages/frontend/tsconfig.json')
);
const dataTsConfig = readJson(
  resolve(templateDir, 'packages/data/tsconfig.json')
);
const sharedTsConfig = readJson(
  resolve(templateDir, 'packages/shared/tsconfig.json')
);
assert(
  frontendTsConfig.compilerOptions.lib.includes('DOM') &&
    frontendTsConfig.compilerOptions.types === undefined,
  'frontend TypeScript profile is browser-only'
);
assert(
  !dataTsConfig.compilerOptions.lib.includes('DOM') &&
    dataTsConfig.compilerOptions.types.includes('node'),
  'data TypeScript profile is Node.js-only'
);
assert(
  !sharedTsConfig.compilerOptions.lib.includes('DOM') &&
    sharedTsConfig.compilerOptions.types === undefined,
  'shared TypeScript profile is isomorphic'
);

const rayfinConfig = readFileSync(
  resolve(targetDir, 'rayfin/rayfin.yml'),
  'utf8'
);
for (const expectedConfig of [
  'path: packages/data',
  'path: packages/frontend',
  'folder: dist',
  'buildCommand: npm run build',
  'buildCommand: npm run build:fabric',
  'assetAccess: protected',
  'only: false',
  'externalEntraExchange: true',
]) {
  assert(
    new RegExp(expectedConfig).test(rayfinConfig),
    `rayfin.yml contains ${expectedConfig.replace('\\n', ' ')}`
  );
}
assert(
  !rayfinConfig.includes('anonymousAccess:'),
  'rayfin.yml uses the current static-hosting access contract'
);
assert(
  !rayfinConfig.includes('functions:'),
  'functions remain opt-in and are not declared by the base template'
);

const mainSource = readFileSync(
  resolve(targetDir, 'packages/frontend/src/main.tsx'),
  'utf8'
);
const rootSource = readFileSync(
  resolve(targetDir, 'packages/frontend/src/Root.tsx'),
  'utf8'
);
assert(
  mainSource.includes('await bootstrapAuth()'),
  'the app bootstraps its dynamic authentication service'
);
assert(
  mainSource.includes('<Root rayfinAuthService={rayfinAuthService} />') &&
    !mainSource.includes('function Root('),
  'main.tsx mounts the separate Fast Refresh root'
);
let providerIndex = -1;
for (const fragment of [
  '<ThemeContext.Provider',
  '<ErrorBoundary',
  '<AuthProvider',
  '<AuthGate>',
  '<App />',
]) {
  const nextIndex = rootSource.indexOf(fragment);
  assert(
    nextIndex > providerIndex,
    `Root.tsx preserves the ${fragment} provider order`
  );
  providerIndex = nextIndex;
}
assert(
  rootSource.includes('<AuthGate>'),
  'the app content remains authenticated'
);

const templateBefore = snapshotTemplate(templateDir);
for (const command of [
  'node --test scripts/generated-app-contract.test.mjs',
  'node --test scripts/pack-combinations.test.mjs',
  'npm run typecheck',
  'npm run lint',
  'npm test',
]) {
  run(command);
}

run('npm run pack:add -- connectors');
run('npm run pack:add -- analytics');
const reapply = run('npm run pack:add -- analytics');
assert(
  reapply.stdout.includes('already installed - skipping install'),
  'analytics reapplication reuses the installed dependency tree'
);

for (const file of [
  'packages/frontend/src/hooks/use-semantic-model-query.ts',
  'packages/frontend/src/hooks/use-semantic-model-query.spec.ts',
]) {
  assert(existsSync(resolve(targetDir, file)), `${file} is installed`);
}
for (const [packageName, relativePackagePath] of [
  ['@microsoft/rayfin-connectors', 'packages/typescript-sdk/connectors'],
  [
    '@microsoft/rayfin-connector-fabric-semanticmodel',
    'packages/typescript-sdk/connector-fabric-semanticmodel',
  ],
]) {
  assert(
    existsSync(resolve(targetDir, 'node_modules', packageName)),
    `${packageName} is installed`
  );
  assert(
    readJson(resolve(targetDir, 'node_modules', packageName, 'package.json'))
      .name === packageName,
    `${packageName} resolves as the expected package`
  );
  assert(
    existsSync(resolve(repoRoot, relativePackagePath, 'dist')),
    `${packageName} local build output exists`
  );
}

for (const command of [
  'npm run typecheck',
  'npm run build',
  'npm run lint',
  'npm test',
]) {
  run(command);
}
assertTemplateUnchanged(templateBefore, snapshotTemplate(templateDir));

const bundleScript = resolve(
  sampleRoot,
  '..',
  'scripts',
  'build-template-bundle.mjs'
);
const baasManifest = resolve(sampleRoot, 'baas-manifest.json');
const bundleResult = spawnSync(
  process.execPath,
  [bundleScript, targetDir, '--manifest', baasManifest],
  { cwd: sampleRoot, shell: false, encoding: 'utf8' }
);
if (bundleResult.stdout) process.stdout.write(bundleResult.stdout);
if (bundleResult.stderr) process.stdout.write(bundleResult.stderr);
if (bundleResult.status !== 0) {
  throw new Error(
    `BaaS bundle build failed with exit code ${bundleResult.status}`
  );
}

const bundleDir = resolve(targetDir, 'rayfin/.temp/workload-template');
for (const artifact of [
  'manifest.json',
  'settings.json',
  'dab-config.json',
  'static-app.zip',
]) {
  assert(existsSync(resolve(bundleDir, artifact)), `${artifact} exists`);
}

const bundleManifest = readJson(resolve(bundleDir, 'manifest.json'));
assert(
  bundleManifest.templateId === 'blankapp',
  'BaaS manifest exposes Universal App as blankapp'
);

const bundleSettings = readJson(resolve(bundleDir, 'settings.json'));
assert(
  bundleSettings.staticHosting.path === undefined &&
    bundleSettings.staticHosting.folder === undefined &&
    bundleSettings.staticHosting.buildCommand === undefined &&
    bundleSettings.data.path === undefined &&
    bundleSettings.data.buildCommand === undefined,
  'BaaS settings exclude source-only build paths and commands'
);
assert(
  bundleSettings.staticHosting.anonymousAccess === false &&
    bundleSettings.staticHosting.embedded.only === false &&
    bundleSettings.staticHosting.assetAccess === undefined,
  'BaaS settings preserve protected hosting with standalone sign-in'
);

const dabConfig = readJson(resolve(bundleDir, 'dab-config.json'));
assert(
  Object.keys(dabConfig.entities).length === 0,
  'base Universal App produces an empty DAB schema'
);

const staticEntries = readZipEntries(resolve(bundleDir, 'static-app.zip'));
assert(staticEntries.has('index.html'), 'static-app.zip contains index.html');
assert(
  [...staticEntries.keys()].some((entry) => /^assets\/.*\.js$/.test(entry)),
  'static-app.zip contains compiled JavaScript'
);
const compiledStaticApp = Buffer.concat([...staticEntries.values()]).toString();
assert(
  compiledStaticApp.includes('Your app is taking shape'),
  'static-app.zip contains the Universal App experience'
);
assert(
  !compiledStaticApp.includes("Can't open this app outside Fabric") &&
    !compiledStaticApp.includes('@fabric-app/source-activity'),
  'the production welcome contains neither a portal-only refusal nor development polling'
);
assert(
  !existsSync(resolve(targetDir, 'packages/frontend/.env.template')),
  'temporary template environment is removed'
);
assertTemplateUnchanged(templateBefore, snapshotTemplate(templateDir));

console.log('\nUniversal App harness tests succeeded');
