import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  localPackageSpec,
  localSdkPackages,
  targetDir,
} from './local-sdk-packages.js';
import { findWorkspacePackageJsonFiles } from './workspace-manifests.js';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

if (!existsSync(targetDir)) {
  throw new Error('target/ does not exist; run the harness build first');
}

for (const packageJsonPath of findWorkspacePackageJsonFiles(targetDir)) {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  let modified = false;

  for (const dependencyField of dependencyFields) {
    const dependencies = manifest[dependencyField];
    if (!dependencies) {
      continue;
    }

    for (const dependencyName of Object.keys(dependencies)) {
      if (!dependencyName.startsWith('@microsoft/rayfin-')) {
        continue;
      }
      if (!(dependencyName in localSdkPackages)) {
        throw new Error(
          `${packageJsonPath} depends on unmapped local SDK ${dependencyName}`
        );
      }

      dependencies[dependencyName] = localPackageSpec(dependencyName);
      modified = true;
    }
  }

  if (modified) {
    writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Linked local Rayfin dependencies in ${packageJsonPath}`);
  }
}
