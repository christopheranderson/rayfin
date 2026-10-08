#!/usr/bin/env node
/**
 * Bundle all sample templates into templates/ for the VS Code extension.
 *
 * Scans samples/ for distributable roots whose package.json has a "template"
 * field, copies them with filtering, and rewrites workspace:* dependencies to
 * published versions.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyTemplateFeatures } from '@microsoft/rayfin-tools-common/_internal/templates';

import { createTemplateFilter } from './template-ignore.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const extensionRoot = resolve(__dirname, '..');
const samplesDir = resolve(extensionRoot, '../../../samples');
const packagesDir = resolve(extensionRoot, '../..');
const templatesDir = join(extensionRoot, 'templates');
const sharedScriptsDir = join(samplesDir, 'scripts');

/**
 * Map every workspace package name to its version.
 *
 * Walks one and two levels deep rather than naming groups, because workspace
 * projects live at both depths: `packages/typescript-sdk/core` and
 * `packages/tools/cli` are nested, while `packages/guide` and
 * `packages/host-docs` sit flat. A hardcoded group list silently misses the
 * flat ones, which surfaces as a template failing to bundle a dependency that
 * is in fact a workspace project.
 */
function buildWorkspaceVersionMap() {
  const versionMap = new Map();

  const record = (dir) => {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.name && pkg.version) versionMap.set(pkg.name, pkg.version);
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

const workspaceVersions = buildWorkspaceVersionMap();

function transformWorkspaceDeps(deps) {
  if (!deps) return deps;
  const out = { ...deps };
  for (const [name, version] of Object.entries(deps)) {
    if (version !== 'workspace:*') continue;
    const resolved = workspaceVersions.get(name);
    if (!resolved) {
      throw new Error(
        `Cannot resolve workspace dep ${name}. Known packages: ${[...workspaceVersions.keys()].join(', ')}`
      );
    }
    out[name] = `^${resolved}`;
  }
  return out;
}

function rewriteNestedManifests(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteNestedManifests(path);
      continue;
    }
    if (entry.name !== 'package.json') continue;
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    for (const kind of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      pkg[kind] = transformWorkspaceDeps(pkg[kind]);
    }
    writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
}

function bundleTemplate(sampleName, sourceSubdirectory = '') {
  const src = join(samplesDir, sampleName, sourceSubdirectory);
  const dest = join(templatesDir, sampleName);

  // Clean destination
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });

  // Copy with filtering (the root package.json is rewritten separately).
  cpSync(src, dest, {
    recursive: true,
    filter: createTemplateFilter(src),
  });

  // Read and transform package.json
  const pkgJson = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));

  // Discover shared scripts referenced in package.json
  const allScripts = Object.values(pkgJson.scripts ?? {}).join(' ');
  const sharedScripts = existsSync(sharedScriptsDir)
    ? readdirSync(sharedScriptsDir)
        .filter((f) => f.endsWith('.js'))
        .filter((f) => allScripts.includes(`../scripts/${f}`))
    : [];

  // Rewrite script paths ../scripts/foo.js → scripts/foo.js
  if (pkgJson.scripts && sharedScripts.length > 0) {
    for (const [key, value] of Object.entries(pkgJson.scripts)) {
      let updated = value;
      for (const script of sharedScripts) {
        updated = updated.replace(
          new RegExp(
            `\\.\\./scripts/${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
            'g'
          ),
          `scripts/${script}`
        );
      }
      pkgJson.scripts[key] = updated;
    }

    // Copy shared scripts into the template
    const destScriptsDir = join(dest, 'scripts');
    mkdirSync(destScriptsDir, { recursive: true });
    for (const script of sharedScripts) {
      cpSync(join(sharedScriptsDir, script), join(destScriptsDir, script));
    }
  }

  // Transform workspace:* dependencies in the root and every member manifest.
  for (const kind of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    pkgJson[kind] = transformWorkspaceDeps(pkgJson[kind]);
  }

  writeFileSync(
    join(dest, 'package.json'),
    JSON.stringify(pkgJson, null, 2) + '\n',
    'utf8'
  );
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    if (entry.isDirectory()) rewriteNestedManifests(join(dest, entry.name));
  }
  applyTemplateFeatures(dest, new Set());
}

// ── Main ──

if (!existsSync(samplesDir)) {
  console.log(`⏭️  Samples directory not found at ${samplesDir}, skipping.`);
  process.exit(0);
}

// Clean existing templates
if (existsSync(templatesDir)) {
  rmSync(templatesDir, { recursive: true, force: true });
}

console.log('📦 Bundling templates for VS Code extension...');

let count = 0;
for (const entry of readdirSync(samplesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const candidates = ['', 'template'];
  const sourceSubdirectory = candidates.find((candidate) => {
    const pkgPath = join(samplesDir, entry.name, candidate, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.template !== undefined;
  });
  if (sourceSubdirectory === undefined) continue;

  console.log(`  ${entry.name}`);
  bundleTemplate(entry.name, sourceSubdirectory);
  count++;
}

console.log(`✅ Bundled ${count} template(s).`);
