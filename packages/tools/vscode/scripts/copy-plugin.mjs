#!/usr/bin/env node
/**
 * Copy the Rayfin agent plugin from its single source of truth (`plugin/` at
 * the repo root) into the VS Code extension so it gets bundled in the vsix.
 *
 * `plugin/` is laid out as the *root of the public microsoft/rayfin repo*, so
 * it already carries the root `plugin.json` the extension needs to register the
 * directory through `chat.pluginLocations`. Only one thing is layered on top:
 *
 *   - `.mcp.json`, plus the matching `mcpServers` block on the copied manifest.
 *     The extension can reasonably assume the Rayfin MCP server is worth
 *     offering, because it controls the environment. The published plugin ships
 *     without it on purpose: it has to work in harnesses where npx-ing a server
 *     on load is not a safe default.
 *
 * That is a build output, not payload. It belongs here rather than in
 * `plugin/`, which has to stay byte-for-byte what we publish.
 *
 * The copy is driven by `git ls-files` rather than walking the directory. A
 * recursive copy takes whatever is sitting in the builder's working tree, so
 * anything gitignored or not yet added -- scratch files, a half-written skill,
 * an editor backup -- ships inside the vsix. The public sync already refuses to
 * publish anything but committed content (`git archive HEAD` in
 * `.github/sync/sync-local.sh`); this is the same guarantee for the other
 * consumer of `plugin/`. Tracked paths are read from the working tree rather
 * than from HEAD so that editing a skill and rebuilding still works.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, '..');
const repoRoot = resolve(extensionRoot, '../../..');
const pluginSource = join(repoRoot, 'plugin');
const pluginDest = join(extensionRoot, 'rayfin');

/** The MCP server the extension offers alongside the skill. */
const MCP_SERVERS = {
  rayfin: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@microsoft/rayfin-mcp', 'start'],
  },
};

/**
 * Every tracked file under `plugin/`, as paths relative to it.
 *
 * Exported so the bundling contract can be asserted against the same list the
 * build uses, instead of a reimplementation of it.
 */
export function trackedPluginFiles(cwd = repoRoot) {
  const stdout = execFileSync('git', ['ls-files', '-z', '--', 'plugin'], {
    cwd,
    encoding: 'utf8',
  });
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((file) => file.slice('plugin/'.length));
}

/** Copy the tracked payload into `dest`, returning the number of files written. */
export function copyTrackedPlugin(source, dest, files) {
  for (const file of files) {
    const target = join(dest, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, file), target);
  }
  return files.length;
}

/**
 * Layer the MCP server onto the copied payload.
 *
 * `files` is the tracked list the copy was driven by. The manifest is read back
 * out of `dest` rather than from the source tree on purpose: the copy only
 * contains tracked files, so reopening the source would make the manifest the
 * one file that bypasses that guarantee. An untracked `plugin.json` sitting in
 * a working tree is skipped by the copy and would still have had its contents
 * read and packaged from here.
 *
 * Exported so the guarantee is asserted against the code the build runs.
 */
export function attachMcpServer(dest, files) {
  if (!files.includes('plugin.json')) {
    throw new Error(
      'plugin/plugin.json is not tracked, so it cannot be published. ' +
        'git add it before building; the extension registers this manifest.'
    );
  }

  const manifestPath = join(dest, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, mcpServers: MCP_SERVERS }, null, 2)}\n`
  );

  writeFileSync(
    join(dest, '.mcp.json'),
    `${JSON.stringify({ mcpServers: MCP_SERVERS }, null, 2)}\n`
  );
}

function main() {
  if (!existsSync(pluginSource)) {
    console.warn('WARN Plugin source not found at', pluginSource);
    process.exit(0);
  }

  let files;
  try {
    files = trackedPluginFiles();
  } catch (error) {
    console.error(
      'ERROR Could not list tracked files under plugin/:',
      error.message
    );
    process.exit(1);
  }

  // An empty list means git answered but the payload is not tracked, which
  // would silently ship an empty plugin. Falling back to a directory walk is
  // exactly the behaviour this replaced, so fail instead.
  if (files.length === 0) {
    console.error('ERROR No tracked files under', pluginSource);
    process.exit(1);
  }

  if (existsSync(pluginDest)) {
    rmSync(pluginDest, { recursive: true });
  }
  mkdirSync(pluginDest, { recursive: true });

  copyTrackedPlugin(pluginSource, pluginDest, files);

  try {
    attachMcpServer(pluginDest, files);
  } catch (error) {
    console.error('ERROR', error.message);
    process.exit(1);
  }

  console.log(`Copied ${files.length} tracked plugin file(s) to ${pluginDest}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
