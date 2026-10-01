import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  localPackageSpec,
  localSdkPackages,
  sampleRoot,
  targetDir,
} from './local-sdk-packages.js';
import {
  assertTemplateUnchanged,
  snapshotTemplate,
} from './template-snapshot.js';
import { findWorkspacePackageJsonFiles } from './workspace-manifests.js';

const templateDir = resolve(sampleRoot, 'template');
const rootPackageJsonPath = resolve(sampleRoot, 'package.json');
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function run(command, cwd = sampleRoot) {
  console.log(`\n> ${command}`);
  const result = spawnSync(command, {
    cwd,
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
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectRayfinDependencies(manifest) {
  const dependencies = new Set();
  for (const dependencyField of dependencyFields) {
    for (const dependencyName of Object.keys(manifest[dependencyField] ?? {})) {
      if (dependencyName.startsWith('@microsoft/rayfin-')) {
        dependencies.add(dependencyName);
      }
    }
  }
  return dependencies;
}

function readWorkspaceManifests(root) {
  return new Map(
    findWorkspacePackageJsonFiles(root).map((manifestPath) => [
      relative(root, manifestPath),
      readManifest(manifestPath),
    ])
  );
}

function assertOuterDeclaresTemplateRayfinDependencies() {
  const harnessManifest = readManifest(rootPackageJsonPath);
  const harnessDependencies = collectRayfinDependencies(harnessManifest);
  const templateDependencies = new Set(
    [...readWorkspaceManifests(templateDir).values()].flatMap((manifest) => [
      ...collectRayfinDependencies(manifest),
    ])
  );
  const missingDependencies = [...templateDependencies]
    .filter((dependencyName) => !harnessDependencies.has(dependencyName))
    .sort();

  if (missingDependencies.length > 0) {
    throw new Error(
      `Outer package.json is missing local Rayfin dependencies: ${missingDependencies.join(
        ', '
      )}`
    );
  }
}

function assertTargetDependencyRewrites() {
  const templateManifests = readWorkspaceManifests(templateDir);
  const targetManifests = readWorkspaceManifests(targetDir);

  for (const [manifestPath, templateManifest] of templateManifests) {
    const targetManifest = targetManifests.get(manifestPath);
    if (!targetManifest) {
      throw new Error(`Target is missing ${manifestPath}`);
    }

    for (const dependencyField of dependencyFields) {
      const templateDependencies = templateManifest[dependencyField] ?? {};
      const targetDependencies = targetManifest[dependencyField] ?? {};

      for (const [dependencyName, templateSpec] of Object.entries(
        templateDependencies
      )) {
        const expectedSpec = dependencyName.startsWith('@microsoft/rayfin-')
          ? localPackageSpec(dependencyName)
          : templateSpec;
        if (targetDependencies[dependencyName] !== expectedSpec) {
          throw new Error(
            `${manifestPath} changed ${dependencyName} to ${targetDependencies[dependencyName]}; expected ${expectedSpec}`
          );
        }
      }
    }
  }
}

function assertInstalledRayfinPackagesAreLocal() {
  for (const [packageName, relativePackagePath] of Object.entries(
    localSdkPackages
  )) {
    const installedPath = resolve(targetDir, 'node_modules', packageName);
    if (!existsSync(installedPath)) {
      throw new Error(`Installed local SDK package is missing: ${packageName}`);
    }

    const expectedPath = resolve(sampleRoot, '..', '..', relativePackagePath);
    if (realpathSync(installedPath) !== realpathSync(expectedPath)) {
      throw new Error(`${packageName} did not resolve to ${expectedPath}`);
    }
  }
}

const templateBefore = snapshotTemplate(templateDir);
const harnessPackageJson = readFileSync(rootPackageJsonPath, 'utf8');

try {
  run('node scripts/clean.js');
  run('npx rayfin init target -t ./template --skip-install --overwrite');
} finally {
  writeFileSync(rootPackageJsonPath, harnessPackageJson);
}

assertTemplateUnchanged(templateBefore, snapshotTemplate(templateDir));
assertOuterDeclaresTemplateRayfinDependencies();
run('node scripts/link-local-sdk.js');
assertTargetDependencyRewrites();
// npm 10's peer resolver crashes on the repository-local file links used by this harness.
run('npm install --legacy-peer-deps', targetDir);
assertInstalledRayfinPackagesAreLocal();
run('npm run build', targetDir);
assertTemplateUnchanged(templateBefore, snapshotTemplate(templateDir));

console.log('\nUniversal App harness build succeeded');
