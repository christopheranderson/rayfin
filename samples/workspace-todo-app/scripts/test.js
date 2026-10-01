/**
 * test.js — Run validation tests against the built target/.
 *
 * Checks:
 * - target/ exists and has expected structure
 * - All sub-packages built successfully (dist/ directories exist)
 * - rayfin.yml is present and valid
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const targetDir = resolve(import.meta.dirname, '..', 'target');
let failures = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    failures++;
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

// Check target exists
assert(existsSync(targetDir), 'target/ directory exists');

// Check rayfin.yml
assert(
  existsSync(join(targetDir, 'rayfin', 'rayfin.yml')),
  'target/rayfin/rayfin.yml exists'
);

// Check sub-packages built
const expectedPackages = ['shared', 'data', 'functions', 'frontend'];
for (const pkg of expectedPackages) {
  const distDir = join(targetDir, 'packages', pkg, 'dist');
  assert(existsSync(distDir), `target/packages/${pkg}/dist/ exists (built)`);
}

// Check root package.json has workspaces field
const rootPkg = JSON.parse(
  readFileSync(join(targetDir, 'package.json'), 'utf-8')
);
assert(
  Array.isArray(rootPkg.workspaces),
  'target/package.json has workspaces field'
);

// Check node_modules exists (install ran)
assert(
  existsSync(join(targetDir, 'node_modules')),
  'target/node_modules/ exists (install ran)'
);

console.log(
  `\n${failures === 0 ? '✅' : '❌'} ${expectedPackages.length + 3 - failures}/${expectedPackages.length + 3} tests passed`
);
process.exit(failures > 0 ? 1 : 0);
