#!/usr/bin/env node
// build-template-bundle.mjs
//
// Assemble a complete template bundle for the BaaS template-deploy feature.
//
// A complete bundle is the 4-file set consumed by the workload's
// ITemplateProvider (embedded as resources in Microsoft.Trident.Workload.BaaS):
//
//   - manifest.json     (source of truth: <sample>/manifest.json or --manifest)
//   - settings.json     (generated from rayfin/rayfin.yml services)
//   - dab-config.json   (generated via `rayfin dev db apply --gen-config-only`)
//   - static-app.zip    (built from the sample's staticHosting output)
//
// Output is written to <sample>/rayfin/.temp/workload-template/ (git-ignored
// via rayfin/.gitignore and covered by the global .templateignore's
// rayfin/.temp/ rule, so nothing leaks into scaffolded user projects).
//
// Usage:
//   node samples/scripts/build-template-bundle.mjs <sample-dir> [<sync-dir>] [--manifest <file>]
//
// If <sync-dir> is provided, the 4 bundle files are also copied there
// (useful for syncing into the workloads-appdev repo's Templates/<name>/).
//
// Example:
//   node samples/scripts/build-template-bundle.mjs \
//       samples/getting-started-auth \
//       /q/Repos/workloads-appdev/Workloads/BaaS/Service/Microsoft.Trident.Workload.BaaS/Templates/gettingstartedauth
//
// Exit codes:
//   0 success
//   1 bad args / missing input
//   2 build failure
//   3 zip failure
//   4 settings/dab-config generation failure
//
// This script is fully cross-platform (Node 20+, no external deps, no shell
// runtime required). It replaces build-template-bundle.sh, zip-dir.ps1, and
// folds in gen-settings.mjs.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Absolute path to the built CLI's offline DAB config generator. The CLI no
// longer exposes a `dev db apply --gen-config-only` command, so the bundle
// builds dab-config.json by driving `generateDabConfig` directly. Requires
// the CLI to be built first: `rush build --to @microsoft/rayfin-cli`.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_DAB_GENERATOR = resolve(
  SCRIPT_DIR,
  '../../packages/tools/cli/dist/utils/dab-config-generator.js'
);

// CRC-32 lookup table used by the inline ZIP writer below. Declared at the
// top of the module so it's fully initialized before the synchronous main
// body calls buildZip(). (Moving this below main would hit a TDZ error.)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const manifestFlagIndex = args.indexOf('--manifest');
let manifestArg = null;
if (manifestFlagIndex !== -1) {
  manifestArg = args[manifestFlagIndex + 1];
  if (!manifestArg) {
    console.error('Error: --manifest requires a file path.');
    process.exit(1);
  }
  args.splice(manifestFlagIndex, 2);
}

const [sampleArg, syncArg] = args;
if (!sampleArg) {
  console.error(
    'Usage: node build-template-bundle.mjs <sample-dir> [<sync-dir>] [--manifest <file>]'
  );
  process.exit(1);
}

const SAMPLE_DIR = resolve(sampleArg);
const SYNC_DIR = syncArg ? resolve(syncArg) : null;

if (!existsSync(join(SAMPLE_DIR, 'package.json'))) {
  console.error(
    `Error: ${SAMPLE_DIR} does not look like a sample (no package.json).`
  );
  process.exit(1);
}

const RAYFIN_YML = join(SAMPLE_DIR, 'rayfin', 'rayfin.yml');
const MANIFEST_SRC = manifestArg
  ? resolve(manifestArg)
  : join(SAMPLE_DIR, 'manifest.json');

if (!existsSync(RAYFIN_YML)) {
  console.error(`Error: ${RAYFIN_YML} not found.`);
  process.exit(1);
}
if (!existsSync(MANIFEST_SRC)) {
  console.error(`Error: ${MANIFEST_SRC} not found.`);
  process.exit(1);
}

const OUTPUT_DIR = join(SAMPLE_DIR, 'rayfin', '.temp', 'workload-template');
mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`==> Building template bundle for: ${SAMPLE_DIR}`);
console.log(`    Output dir:                    ${OUTPUT_DIR}`);
if (SYNC_DIR) console.log(`    Sync dir:                      ${SYNC_DIR}`);

// ---------------------------------------------------------------------------
// Minimal YAML parser for rayfin.yml's well-defined subset.
// Supports: scalars, nested maps (indentation-based), dash-lists of scalars.
// Does NOT support: anchors, aliases, flow collections, multi-line strings,
// block scalars, complex keys, or tags.
// ---------------------------------------------------------------------------
function parseSimpleYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue;

    const indent = raw.search(/\S/);
    const content = raw.slice(indent);

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    if (content.startsWith('- ')) {
      const val = castScalar(content.slice(2).trim());
      if (Array.isArray(parent)) parent.push(val);
      continue;
    }

    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) continue;

    const key = content.slice(0, colonIdx).trim();
    const after = content.slice(colonIdx + 1).trim();

    if (after === '') {
      const next = peekNextContent(lines, i);
      if (next !== null && next.trimStart().startsWith('- ')) {
        const arr = [];
        parent[key] = arr;
        stack.push({ indent, obj: arr });
      } else {
        const child = {};
        parent[key] = child;
        stack.push({ indent, obj: child });
      }
    } else {
      parent[key] = castScalar(after);
    }
  }

  return root;
}

function peekNextContent(lines, currentIndex) {
  for (let i = currentIndex + 1; i < lines.length; i++) {
    if (!/^\s*$/.test(lines[i]) && !/^\s*#/.test(lines[i])) return lines[i];
  }
  return null;
}

function castScalar(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  if (/^-?\d+$/.test(val)) return Number(val);
  if (/^-?\d+\.\d+$/.test(val)) return Number(val);
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// 1. Parse staticHosting fields from rayfin.yml.
// ---------------------------------------------------------------------------
const ymlRaw = readFileSync(RAYFIN_YML, 'utf8');
const ymlParsed = parseSimpleYaml(ymlRaw);

if (!ymlParsed?.services?.staticHosting) {
  console.error(`Error: services.staticHosting not found in ${RAYFIN_YML}`);
  process.exit(1);
}

const STATIC_FOLDER = ymlParsed.services.staticHosting.folder;
const STATIC_PATH = ymlParsed.services.staticHosting.path || '.';
const DATA_PATH = ymlParsed.services.data?.path || '.';
const DATA_BUILD_COMMAND = ymlParsed.services.data?.buildCommand;

if (!STATIC_FOLDER) {
  console.error(
    `Error: services.staticHosting.folder not found in ${RAYFIN_YML}`
  );
  process.exit(1);
}

console.log(`    staticHosting.folder:          ${STATIC_FOLDER}`);
console.log(`    staticHosting.path:            ${STATIC_PATH}`);
const STATIC_ROOT = resolve(SAMPLE_DIR, STATIC_PATH);
const DATA_ROOT = resolve(SAMPLE_DIR, DATA_PATH);

// ---------------------------------------------------------------------------
// 1b. Generate .env.template from manifest.json tokens.
//     Vite's `--mode template` reads this file so the built JS embeds the
//     literal __TOKEN__ placeholder strings that ZipTokenReplacer replaces
//     at deploy time.
//
//     The legacy `.env.fabric` name has been retired — nothing in the
//     normal user workflow reads `.env.fabric*` anymore. Using a distinct
//     `.env.template` keeps the placeholder values isolated to this build
//     script and out of `vite dev` / `npm run build`.
// ---------------------------------------------------------------------------
const TOKEN_TO_VITE = {
  __RAYFIN_API_URL__: 'VITE_RAYFIN_API_URL',
  __RAYFIN_PK__: 'VITE_RAYFIN_PUBLISHABLE_KEY',
  __FABRIC_ITEM_ID__: 'VITE_FABRIC_ITEM_ID',
  __FABRIC_WORKSPACE_ID__: 'VITE_FABRIC_WORKSPACE_ID',
  __FABRIC_PORTAL_URL__: 'VITE_FABRIC_PORTAL_URL',
};

const manifestJson = JSON.parse(readFileSync(MANIFEST_SRC, 'utf8'));
const manifestTokens = Array.isArray(manifestJson.tokens)
  ? manifestJson.tokens
  : [];

const ENV_FABRIC = join(STATIC_ROOT, '.env.template');
console.log('--> Generating .env.template from manifest.json tokens');
{
  const lines = [
    '# Auto-generated by build-template-bundle.mjs — DO NOT EDIT',
    '# Each VITE_* var is set to its __TOKEN__ placeholder so that',
    '# vite build --mode template embeds them as literal strings.',
  ];
  for (const token of manifestTokens) {
    const viteVar = TOKEN_TO_VITE[token];
    if (viteVar) {
      lines.push(`${viteVar}=${token}`);
    } else {
      console.error(
        `WARNING: manifest.json token '${token}' has no VITE_* mapping in build-template-bundle.mjs`
      );
    }
  }
  writeFileSync(ENV_FABRIC, lines.join('\n') + '\n', 'utf8');
}
console.log(`    Wrote: ${ENV_FABRIC}`);

// ---------------------------------------------------------------------------
// 2. Generate settings.json from rayfin.yml (services block, with build-only
//    fields stripped).
// ---------------------------------------------------------------------------
console.log('--> Generating settings.json');
const servicesOut = structuredClone(ymlParsed.services);
for (const service of Object.values(servicesOut)) {
  if (service && typeof service === 'object') {
    delete service.path;
    delete service.folder;
    delete service.buildCommand;
  }
}
const staticHostingOut = servicesOut.staticHosting;
if (staticHostingOut && typeof staticHostingOut === 'object') {
  const { assetAccess } = staticHostingOut;
  if (assetAccess !== undefined) {
    if (assetAccess !== 'protected' && assetAccess !== 'public') {
      console.error(
        `Error: services.staticHosting.assetAccess must be "protected" or "public", but is ${JSON.stringify(assetAccess)}.`
      );
      process.exit(4);
    }
    staticHostingOut.anonymousAccess = assetAccess === 'public';
    delete staticHostingOut.assetAccess;
  } else if (
    staticHostingOut.enabled === true &&
    typeof staticHostingOut.anonymousAccess !== 'boolean'
  ) {
    staticHostingOut.anonymousAccess = false;
  }
}
// The runtime `ServiceSettings` model marks `storage` (and `auth`/`data`) as
// required, so deserialization fails if a sample's rayfin.yml omits them.
// Default any missing required service block to a disabled config.
for (const requiredService of ['auth', 'data', 'storage']) {
  if (
    !servicesOut[requiredService] ||
    typeof servicesOut[requiredService] !== 'object'
  ) {
    servicesOut[requiredService] = { enabled: false };
  }
}
writeFileSync(
  join(OUTPUT_DIR, 'settings.json'),
  JSON.stringify(servicesOut, null, 2) + '\n',
  'utf8'
);

// ---------------------------------------------------------------------------
// 3. Generate dab-config.json via `rayfin dev db apply --gen-config-only`.
//    The CLI writes to <sample>/rayfin/.temp/dab-config.json; copy it out.
// ---------------------------------------------------------------------------
console.log(
  '--> Generating dab-config.json (offline, via @microsoft/rayfin-core)'
);
// The CLI's `generateDabConfig` compiles the sample's rayfin/data entities and
// writes rayfin/.temp/dab-config.json. When a sample defines no entities it
// returns without writing a file, so fall back to an empty-but-valid config
// (identical to `new ConfigGenerator(dialect).generateConfig([])`).
// Run in a child process whose cwd is the sample so the generator's project-
// root and module resolution resolve against the sample, not the repo root.
const DAB_GEN_SCRIPT = [
  `import { generateDabConfig } from ${JSON.stringify(pathToFileURL(CLI_DAB_GENERATOR).href)};`,
  `import { ConfigGenerator } from '@microsoft/rayfin-core/analysis';`,
  `import { mkdirSync, writeFileSync } from 'node:fs';`,
  `import { join } from 'node:path';`,
  `const result = await generateDabConfig({`,
  `  verbose: false,`,
  `  projectRoot: process.cwd(),`,
  `  serviceRoot: ${JSON.stringify(DATA_ROOT)},`,
  `  buildCommand: ${JSON.stringify(DATA_BUILD_COMMAND)},`,
  `});`,
  `if (!result.configPath) {`,
  `  const tmp = join(process.cwd(), 'rayfin', '.temp');`,
  `  mkdirSync(tmp, { recursive: true });`,
  `  const cfg = new ConfigGenerator('mssql').generateConfig([]);`,
  `  writeFileSync(join(tmp, 'dab-config.json'), JSON.stringify(cfg, null, 2));`,
  `  console.log('    No entities found — wrote empty dab-config.json');`,
  `}`,
].join('\n');
const dab = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', DAB_GEN_SCRIPT],
  { cwd: SAMPLE_DIR, stdio: 'inherit' }
);
if (dab.status !== 0) {
  console.error(
    "Error: dab-config generation failed. Build the CLI first: 'rush build --to @microsoft/rayfin-cli'."
  );
  process.exit(4);
}

const DAB_SRC = join(SAMPLE_DIR, 'rayfin', '.temp', 'dab-config.json');
if (!existsSync(DAB_SRC)) {
  console.error(`Error: expected ${DAB_SRC} to exist after gen-config-only.`);
  process.exit(4);
}
copyFileSync(DAB_SRC, join(OUTPUT_DIR, 'dab-config.json'));
console.log(`    Copied: ${DAB_SRC} -> ${join(OUTPUT_DIR, 'dab-config.json')}`);

// ---------------------------------------------------------------------------
// 4. Run the app build and zip <staticHosting.folder> into static-app.zip.
//
//     The bundle build deliberately bypasses `services.staticHosting.buildCommand`
//     (which is the user-facing `npm run build`, deployment-bound to
//     `.env.local`).  The template bundle needs `__TOKEN__` placeholders
//     embedded instead, so we invoke `vite build --mode template` directly
//     and rely on the `.env.template` file generated in step 1b.  The
//     accompanying type-check (`tsc -b`) mirrors what the user-facing
//     build script does without needing to know its exact command name.
// ---------------------------------------------------------------------------
// Samples that depend on @microsoft/fabric-app-data must run its codegen
// (producing src/fabric.generated.ts) before type-checking, and build with
// --noCheck — mirroring their own `build:fabric` script.
const samplePkg = JSON.parse(
  readFileSync(join(STATIC_ROOT, 'package.json'), 'utf8')
);
const sampleDeps = {
  ...(samplePkg.dependencies || {}),
  ...(samplePkg.devDependencies || {}),
};
const needsFabricDataCodegen = Boolean(
  sampleDeps['@microsoft/fabric-app-data']
);
const codegenPrefix = needsFabricDataCodegen
  ? 'npx --no-install fabric-app-data generate -o src/fabric.generated.ts && '
  : '';
const tscCmd = needsFabricDataCodegen
  ? 'npx --no-install tsc -b --noCheck'
  : 'npx --no-install tsc -b';
const TEMPLATE_BUILD_CMD = `${codegenPrefix}${tscCmd} && npx --no-install vite build --mode template`;
console.log(`--> Running template build: ${TEMPLATE_BUILD_CMD}`);
const STATIC_ABS = join(STATIC_ROOT, STATIC_FOLDER);
rmSync(STATIC_ABS, { recursive: true, force: true });

// Use the platform shell so the chained command (with `&&`) parses correctly.
const shellOpts =
  process.platform === 'win32'
    ? { shell: process.env.ComSpec || 'cmd.exe' }
    : { shell: '/bin/sh' };
const build = spawnSync(TEMPLATE_BUILD_CMD, {
  cwd: STATIC_ROOT,
  stdio: 'inherit',
  ...shellOpts,
});
if (build.status !== 0) {
  console.error(`Error: template build exited with status ${build.status}`);
  process.exit(2);
}
if (!existsSync(STATIC_ABS) || !statSync(STATIC_ABS).isDirectory()) {
  console.error(
    `Error: buildCommand completed but ${STATIC_ABS} was not produced.`
  );
  process.exit(2);
}

const STATIC_ZIP = join(OUTPUT_DIR, 'static-app.zip');
rmSync(STATIC_ZIP, { force: true });

try {
  writeFileSync(STATIC_ZIP, buildZip(STATIC_ABS));
} catch (err) {
  console.error(`Error: failed to create static-app.zip: ${err.message}`);
  process.exit(3);
}
if (!existsSync(STATIC_ZIP) || statSync(STATIC_ZIP).size === 0) {
  console.error('Error: static-app.zip was not created or is empty.');
  process.exit(3);
}
console.log(`    Wrote: ${STATIC_ZIP} (${statSync(STATIC_ZIP).size} bytes)`);

// ---------------------------------------------------------------------------
// 5. Copy manifest.json.
// ---------------------------------------------------------------------------
copyFileSync(MANIFEST_SRC, join(OUTPUT_DIR, 'manifest.json'));
console.log(
  `    Copied: manifest.json -> ${join(OUTPUT_DIR, 'manifest.json')}`
);

// ---------------------------------------------------------------------------
// 6. Optional sync.
// ---------------------------------------------------------------------------
if (SYNC_DIR) {
  mkdirSync(SYNC_DIR, { recursive: true });
  for (const f of [
    'manifest.json',
    'settings.json',
    'dab-config.json',
    'static-app.zip',
  ]) {
    copyFileSync(join(OUTPUT_DIR, f), join(SYNC_DIR, f));
  }
  console.log(`    Synced bundle -> ${SYNC_DIR}`);
}

// ---------------------------------------------------------------------------
// 7. Cross-check: verify every VITE_* in .env.template has a matching token
//    in manifest.json.
// ---------------------------------------------------------------------------
const VITE_TO_TOKEN = Object.fromEntries(
  Object.entries(TOKEN_TO_VITE).map(([k, v]) => [v, k])
);
const manifestText = readFileSync(join(OUTPUT_DIR, 'manifest.json'), 'utf8');
const envLines = readFileSync(ENV_FABRIC, 'utf8').split(/\r?\n/);
let warned = false;
for (const line of envLines) {
  if (!line || line.startsWith('#')) continue;
  const key = line.split('=')[0].trim();
  const token = VITE_TO_TOKEN[key];
  if (!token) continue;
  if (!manifestText.includes(`"${token}"`)) {
    if (!warned) {
      console.error('');
      console.error(
        'WARNING: .env.template contains VITE_* vars whose __TOKEN__ counterpart'
      );
      console.error('         is missing from manifest.json (tokens[]):');
      warned = true;
    }
    console.error(`  - ${key}  =>  ${token}`);
  }
}
if (warned) {
  console.error(
    "         Add the missing token(s) to the sample's manifest.json so the"
  );
  console.error('         workload substitutes them at deploy time.');
}

// ---------------------------------------------------------------------------
// 8. Clean up: remove .env.template so it does not leak into normal
//    `npm run build` / `vite dev` invocations and is not committed.
// ---------------------------------------------------------------------------
try {
  rmSync(ENV_FABRIC, { force: true });
  console.log(`    Cleaned: ${ENV_FABRIC}`);
} catch {
  // Best-effort cleanup; safe to ignore.
}

console.log('==> Done.');

// ===========================================================================
// Minimal cross-platform ZIP writer.
//
// Produces a standards-compliant ZIP archive with forward-slash entry names
// (as required by the ZIP spec / APPNOTE 4.4.17.1) and DEFLATE compression.
// Pure Node, no external deps.
//
// Supports only the subset we need: regular files, no symlinks, no ZIP64,
// no encryption. Archives larger than ~4GiB or containing >65535 entries
// are not supported (and not expected for static web bundles).
// ===========================================================================
function buildZip(sourceDir) {
  const files = [];
  walk(sourceDir, sourceDir, files);
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = readFileSync(f.abs);
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const stored = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    // Local file header (APPNOTE 4.3.7).
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // general purpose bit flag (bit 11 = UTF-8 names)
    lfh.writeUInt16LE(method, 8); // compression method
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(stored.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len
    localParts.push(lfh, nameBuf, stored);

    // Central directory header (APPNOTE 4.3.12).
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(stored.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + stored.length;
  }

  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const centralOffset = offset;

  // End of central directory record.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function walk(root, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, abs, out);
    } else if (entry.isFile()) {
      const rel = relative(root, abs).split(sep).join('/');
      out.push({ abs, name: rel });
    }
  }
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
