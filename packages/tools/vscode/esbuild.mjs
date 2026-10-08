/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from 'esbuild';
import { sassPlugin } from 'esbuild-sass-plugin';
import { mkdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Version of the bundled Rayfin deploy logic, declared to the workload as the
 * client identity on runtime-settings writes. tools-common is bundled, so its
 * manifest is not readable at runtime and the version is baked in here.
 */
const deployClientVersion = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve(
      '@microsoft/rayfin-tools-common/package.json'
    ),
    'utf-8'
  )
).version;

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  target: 'es2022',
  logLevel: 'warning',
  define: {
    __RAYFIN_DEPLOY_CLIENT_VERSION__: JSON.stringify(deployClientVersion),
  },
};

/** Desktop extension host — Node.js, CommonJS */
/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  ...sharedOptions,
  entryPoints: ['src/extension.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/main.js',
  external: ['vscode'],
};

/** Web extension — browser worker, CommonJS */
/** @type {import('esbuild').BuildOptions} */
const webExtensionConfig = {
  ...sharedOptions,
  entryPoints: ['src/web/extension.ts'],
  format: 'cjs',
  platform: 'browser',
  outfile: 'dist/web/extension.js',
  external: [
    'vscode',
    'fs',
    'fs/promises',
    'child_process',
    'os',
    'path',
    'util',
  ],
  mainFields: ['browser', 'module', 'main'],
};

/** React webview bundle — browser, ESM */
/** @type {import('esbuild').BuildOptions} */
const viewsConfig = {
  ...sharedOptions,
  entryPoints: ['src/webviews/index.tsx'],
  format: 'esm',
  platform: 'browser',
  outfile: 'dist/views.js',
  external: ['fs', 'fs/promises', 'child_process', 'os', 'path', 'util'],
  jsx: 'automatic',
  loader: {
    '.svg': 'dataurl',
  },
  plugins: [sassPlugin()],
  mainFields: ['browser', 'module', 'main'],
};

function copyDistAssets() {
  mkdirSync('dist', { recursive: true });
}

async function main() {
  copyDistAssets();

  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webExtensionConfig),
      esbuild.context(viewsConfig),
    ]);
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webExtensionConfig),
      esbuild.build(viewsConfig),
    ]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
