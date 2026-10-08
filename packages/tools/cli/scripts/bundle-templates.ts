#!/usr/bin/env node
/**
 * Bundle templates from samples/ into templates/ directory before publishing.
 * This transforms workspace:* dependencies to published versions.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { basename, resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createTemplateIgnoreMatcher,
  readTemplateIgnoreFile,
  type TemplateIgnoreSource,
} from './templateignore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageRoot = resolve(__dirname, '..');
const samplesDir = resolve(packageRoot, '../../../samples');
const templatesDir = resolve(packageRoot, 'templates');
const globalTemplateIgnorePath = join(__dirname, '.templateignore');
const sharedScriptsDir = join(samplesDir, 'scripts');

/**
 * Discover shared scripts from samples/scripts/ directory.
 * These can be referenced by templates using ../scripts/ paths.
 * They will be copied into each template's scripts/ directory during bundling,
 * and package.json script references will be rewritten to use local paths.
 */
function discoverSharedScripts(): string[] {
  if (!existsSync(sharedScriptsDir)) {
    return [];
  }
  return readdirSync(sharedScriptsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.js'))
    .map((dirent) => dirent.name);
}

const SHARED_SCRIPTS = discoverSharedScripts();

console.log('🔨 Bundling templates for publishing...');
if (SHARED_SCRIPTS.length > 0) {
  console.log(
    `  Discovered ${SHARED_SCRIPTS.length} shared script(s): ${SHARED_SCRIPTS.join(', ')}`
  );
}

// Clean existing templates directory
if (existsSync(templatesDir)) {
  console.log('  Removing existing templates directory...');
  rmSync(templatesDir, { recursive: true, force: true });
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  template?: unknown;
  [key: string]: unknown;
}

/**
 * Build a map of package name → version by scanning package.json files
 * under the monorepo packages/ directory. This avoids fragile name→path
 * guessing that breaks for packages whose directory name doesn't match
 * the npm package name suffix (e.g. \@microsoft/rayfin-tools-common → common).
 *
 * Walks one and two levels deep rather than naming groups, because workspace
 * projects live at both depths: `packages/typescript-sdk/core` and
 * `packages/tools/cli` are nested, while `packages/guide` and
 * `packages/host-docs` sit flat. A hardcoded group list silently misses the
 * flat ones, which surfaces as a template failing to bundle a dependency that
 * is in fact a workspace project.
 */
function buildWorkspaceVersionMap(packagesDir: string): Map<string, string> {
  const versionMap = new Map<string, string>();

  const record = (dir: string): void => {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return;

    try {
      const pkg: PackageJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.name && pkg.version) {
        versionMap.set(pkg.name, pkg.version);
      }
    } catch {
      // Skip unreadable package.json files
    }
  };

  if (!existsSync(packagesDir)) return versionMap;

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    record(dir);

    for (const nested of readdirSync(dir, { withFileTypes: true })) {
      if (nested.isDirectory()) record(join(dir, nested.name));
    }
  }

  return versionMap;
}

/**
 * Transform workspace:* dependencies to published versions.
 * Uses the workspace version map built from actual package.json files.
 */
function transformWorkspaceDependencies(
  dependencies: Record<string, string> | undefined,
  versionMap: Map<string, string>
): Record<string, string> | undefined {
  if (!dependencies) return dependencies;

  const transformed = { ...dependencies };

  for (const [name, version] of Object.entries(dependencies)) {
    if (version === 'workspace:*') {
      const resolvedVersion = versionMap.get(name);

      if (!resolvedVersion) {
        throw new Error(
          `Cannot resolve workspace dependency ${name}: package not found in workspace. Known packages: ${[...versionMap.keys()].join(', ')}`
        );
      }

      transformed[name] = `^${resolvedVersion}`;
      console.log(`    Transformed ${name}: workspace:* → ^${resolvedVersion}`);
    }
  }

  return transformed;
}

function transformManifestDependencies(
  packageJson: PackageJson,
  versionMap: Map<string, string>
): PackageJson {
  return {
    ...packageJson,
    dependencies: transformWorkspaceDependencies(
      packageJson.dependencies,
      versionMap
    ),
    devDependencies: transformWorkspaceDependencies(
      packageJson.devDependencies,
      versionMap
    ),
    optionalDependencies: transformWorkspaceDependencies(
      packageJson.optionalDependencies,
      versionMap
    ),
    peerDependencies: transformWorkspaceDependencies(
      packageJson.peerDependencies,
      versionMap
    ),
  };
}

function rewriteNestedManifests(
  directory: string,
  versionMap: Map<string, string>,
  templateRoot = directory
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteNestedManifests(entryPath, versionMap, templateRoot);
      continue;
    }
    if (entry.name !== 'package.json') continue;

    try {
      const packageJson: PackageJson = JSON.parse(
        readFileSync(entryPath, 'utf8')
      );
      if (
        packageJson === null ||
        typeof packageJson !== 'object' ||
        Array.isArray(packageJson)
      ) {
        throw new Error('Expected a JSON object.');
      }
      const transformed = transformManifestDependencies(
        packageJson,
        versionMap
      );
      // Preserve literal manifests and nested script paths byte-for-byte.
      if (JSON.stringify(transformed) !== JSON.stringify(packageJson)) {
        writeFileSync(
          entryPath,
          JSON.stringify(transformed, null, 2) + '\n',
          'utf8'
        );
      }
    } catch (error) {
      throw new Error(
        `Cannot bundle nested manifest ${relative(templateRoot, entryPath)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }
}

/**
 * npm-packlist omits literal `.gitignore` files. Keep template ignore files
 * under a pack-safe name and restore them when a template is scaffolded.
 */
function renameGitignoreFiles(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      renameGitignoreFiles(entryPath);
    } else if (entry.name === '.gitignore') {
      renameSync(entryPath, join(directory, '.gitignore.template'));
    }
  }
}

// Find all sample directories (will filter for template metadata later)
const sampleDirs = readdirSync(samplesDir, { withFileTypes: true })
  .filter((dirent) => dirent.isDirectory())
  .map((dirent) => dirent.name)
  .sort();

let bundledCount = 0;
const packagesDir = resolve(packageRoot, '../..');
const workspaceVersionMap = buildWorkspaceVersionMap(packagesDir);

const globalTemplateIgnoreResult = readTemplateIgnoreFile(
  globalTemplateIgnorePath
);
if (!globalTemplateIgnoreResult.exists) {
  throw new Error(
    `Global .templateignore is missing at ${globalTemplateIgnorePath}. Please ensure it exists before bundling templates.`
  );
}

console.log(
  `  Using global .templateignore: ${globalTemplateIgnoreResult.source}`
);

const globalTemplateIgnoreSource: TemplateIgnoreSource = {
  source: globalTemplateIgnoreResult.source,
  patterns: globalTemplateIgnoreResult.patterns,
};

for (const sampleName of sampleDirs) {
  try {
    const sampleRoot = join(samplesDir, sampleName);
    const samplePath = [sampleRoot, join(sampleRoot, 'template')].find(
      (candidate) => {
        const candidateManifest = join(candidate, 'package.json');
        if (!existsSync(candidateManifest)) return false;
        const packageJson: PackageJson = JSON.parse(
          readFileSync(candidateManifest, 'utf8')
        );
        return packageJson.template !== undefined;
      }
    );
    if (samplePath === undefined) continue;

    const packageJsonPath = join(samplePath, 'package.json');
    const packageJson: PackageJson = JSON.parse(
      readFileSync(packageJsonPath, 'utf8')
    );

    const destPath = join(templatesDir, sampleName);
    console.log(`  Copying ${sampleName}...`);

    // Detect which shared scripts are referenced in package.json
    const allScripts = Object.values(packageJson.scripts ?? {}).join(' ');
    const referencedSharedScripts = SHARED_SCRIPTS.filter((scriptName) =>
      allScripts.includes(`../scripts/${scriptName}`)
    );

    const templateTemplateIgnorePath = join(samplePath, '.templateignore');
    const templateTemplateIgnoreResult = readTemplateIgnoreFile(
      templateTemplateIgnorePath
    );
    const templateIgnoreSources: TemplateIgnoreSource[] = [
      globalTemplateIgnoreSource,
    ];

    if (
      templateTemplateIgnoreResult.exists &&
      templateTemplateIgnoreResult.patterns.length > 0
    ) {
      templateIgnoreSources.push({
        source: templateTemplateIgnoreResult.source,
        patterns: templateTemplateIgnoreResult.patterns,
      });
      console.log(
        `    Applying ${templateTemplateIgnoreResult.patterns.length} template-specific ignore pattern(s)`
      );
    }

    const matcher = createTemplateIgnoreMatcher(
      samplePath,
      templateIgnoreSources
    );
    matcher.warnings.forEach((warning) => console.warn(`    ⚠️  ${warning}`));

    let excludedEntries = 0;

    // Create destination directory
    mkdirSync(destPath, { recursive: true });

    cpSync(samplePath, destPath, {
      recursive: true,
      filter: (src) => {
        if (src === samplePath) {
          return true;
        }

        const name = basename(src);
        // Do not dereference manifest links, including dangling ones.
        // Other paths retain their existing directory-ignore semantics.
        const isLinkedManifest =
          name === 'package.json' && lstatSync(src).isSymbolicLink();
        const isDir = !isLinkedManifest && statSync(src).isDirectory();

        // The root manifest is rewritten separately. Workspace member
        // manifests must remain in the bundle and are normalized below.
        if (src === packageJsonPath && !isDir) {
          return false;
        }

        if (matcher.shouldExclude(src, isDir)) {
          excludedEntries++;
          return false;
        }

        if (isLinkedManifest) {
          throw new Error(
            `Cannot bundle nested manifest ${relative(samplePath, src)}: ` +
              'Symbolic links are not supported.\n' +
              '   Replace the link with a regular file.'
          );
        }

        return true;
      },
    });
    renameGitignoreFiles(destPath);

    console.log(
      `    Skipped ${excludedEntries} entr${excludedEntries === 1 ? 'y' : 'ies'} via .templateignore`
    );

    // Rewrite package.json scripts to replace ../scripts/<name> with scripts/<name>
    let adjustedScripts: Record<string, string> | undefined;
    if (packageJson.scripts && referencedSharedScripts.length > 0) {
      adjustedScripts = { ...packageJson.scripts };

      // Pre-compile regexes for shared script path rewriting
      const scriptPatterns = referencedSharedScripts.map((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return {
          name,
          regex: new RegExp(`\\.\\./scripts/${escaped}`, 'g'),
        };
      });

      // For each script in package.json, replace all references to shared scripts
      for (const [scriptKey, scriptValue] of Object.entries(adjustedScripts)) {
        let updatedValue = scriptValue;
        for (const { name: sharedScript, regex } of scriptPatterns) {
          updatedValue = updatedValue.replace(regex, `scripts/${sharedScript}`);
          if (updatedValue !== scriptValue) {
            console.log(
              `    Rewriting script ${scriptKey}: ${scriptValue} → ${updatedValue}`
            );
          }
        }
        adjustedScripts[scriptKey] = updatedValue;
      }
    }

    // Copy all referenced shared scripts into the template
    if (referencedSharedScripts.length > 0) {
      const destScriptsDir = join(destPath, 'scripts');
      mkdirSync(destScriptsDir, { recursive: true });

      for (const scriptName of referencedSharedScripts) {
        const sharedScriptPath = join(sharedScriptsDir, scriptName);
        if (!existsSync(sharedScriptPath)) {
          throw new Error(
            `Shared script missing at ${sharedScriptPath}. Please ensure samples/scripts/ contains ${scriptName}.`
          );
        }
        console.log(`    Copying ${scriptName} into ${destScriptsDir}...`);
        copyFileSync(sharedScriptPath, join(destScriptsDir, scriptName));
      }
    }

    rewriteNestedManifests(destPath, workspaceVersionMap);
    const transformedPackageJson = transformManifestDependencies(
      {
        ...packageJson,
        scripts: adjustedScripts ?? packageJson.scripts,
      },
      workspaceVersionMap
    );

    writeFileSync(
      join(destPath, 'package.json'),
      JSON.stringify(transformedPackageJson, null, 2) + '\n',
      'utf8'
    );

    bundledCount++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ Failed to bundle ${sampleName}: ${message}`);
    process.exit(1);
  }
}

console.log(`✅ Bundled ${bundledCount} template(s) successfully!`);
