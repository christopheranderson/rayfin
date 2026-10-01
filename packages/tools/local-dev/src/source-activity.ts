//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// Development-only source-activity feed. It watches the app's own source tree
// and reports which building blocks of a Fabric App changed as you edit them:
// screens, live data, calculations, saved entries, secure actions, connections
// and look and feel. It observes edits only. It never claims completion, never
// reads outside the project source, and never returns file contents, secrets,
// environment values, absolute paths or raw prose. Server-only module: it is
// imported by the Vite dev plugin and never bundled into the client app.

import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { parseDocument } from 'yaml';

export const ACTIVITY_FAMILIES = [
  'screens',
  'reads',
  'logic',
  'data',
  'actions',
  'connections',
  'styling',
] as const;

type ActivityFamily = (typeof ACTIVITY_FAMILIES)[number];
type ChangeKind = 'add' | 'update' | 'delete';
interface ActivityChange {
  id: string;
  family: ActivityFamily;
  kind: ChangeKind;
  at: string;
}
interface ActivityEntry {
  family: ActivityFamily;
  fingerprint: string;
  label?: string | null;
}
interface ActivityCollection {
  files: Map<string, ActivityEntry>;
  welcome: boolean;
  invalidConnectors: boolean;
}
interface ActivitySnapshot {
  structure: {
    family: ActivityFamily;
    count: number;
    lastChangedAt: string | null;
    names?: string[];
  }[];
  changes: ActivityChange[];
  generatedAt: string;
  welcome: boolean;
}
type EntryResult =
  | { kind: 'skip' | 'missing' | 'invalid-connectors' }
  | { kind: 'stock'; welcome?: boolean }
  | { kind: 'connectors'; entries: Map<string, ActivityEntry> }
  | { kind: 'file'; key: string; entry: ActivityEntry };
interface SourceReader {
  (path: string): Promise<Buffer>;
  (path: string, encoding: 'utf8'): Promise<string>;
}
interface SourceActivityOptions {
  root?: string;
  now?: () => number;
  collect?: (root: string) => Promise<ActivityCollection>;
  read?: SourceReader;
}
interface ActivityConnector {
  name: string;
  label: string | null;
  fingerprint: string;
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

const MAX_CHANGES = 20;
const MAX_HASHED_BYTES = 256_000n;
const CONNECTOR_CONFIG = 'rayfin/rayfin.yml';
const SOURCE_ROOTS = [
  'packages/frontend/src/',
  'packages/shared/src/',
  'packages/data/src/',
  'packages/functions/src/',
  'rayfin/data/',
  'rayfin/functions/',
  'rayfin/connectors/',
];

const excluded = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'inspection',
  'test',
  'tests',
  '__tests__',
  'bin',
  'obj',
]);

// sha256 of the stock `packages/frontend/src/global.css` that ships with this
// template. global.css is the recommended place to edit theme tokens, so it must
// count toward "Look and feel" once a builder changes it. But a pristine starter
// should not look authored, so an unchanged stock file is not counted. Pinning
// the hash (rather than snapshotting per session) keeps that distinction stable
// across dev-server restarts. If the shipped global.css is intentionally updated,
// update this hash.
const STOCK_GLOBAL_CSS_SHA =
  '75463fa01ef2c92be7223c4247d44f38d1d9bc06c50b14ebbdd037f44c07cc02';

// Stock template files that ship with every app and are present from the first
// render. Counting them would make an untouched starter look partly built.
// Paths are workspace-relative (the feed root is the app workspace, not the Vite
// frontend root). `global.css` is deliberately NOT here: it is content-checked
// against the stock hash instead, so real theme edits still register.
const templateFiles = new Set([
  'packages/frontend/src/main.tsx',
  'packages/frontend/src/Root.tsx',
  'packages/frontend/src/components/auth-gate.component.tsx',
  'packages/frontend/src/services/rayfin-auth.service.ts',
  'packages/frontend/src/lib/rayfin-client.ts',
  'packages/frontend/src/lib/utils.ts',
]);

function normalized(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

// Skip dotfiles, dependency and output trees, tests, generated declarations, the
// welcome surface itself, and stock scaffolding the template owns. Paths are
// relative to the app workspace root, so the frontend source lives under
// `packages/frontend/src/`.
export function ignoreActivityPath(path: string): boolean {
  const name = normalized(path);
  return (
    name
      .split('/')
      .some((part) => part.startsWith('.') || excluded.has(part)) ||
    /(?:^|\/)(?:Welcome|Finley|FabricAppMark|ErrorFallback|EmptyStatePreview)[^/]*$/.test(
      name
    ) ||
    /^packages\/frontend\/src\/hooks\/(?:theme|use-theme|auth\.|use-auth)/.test(
      name
    ) ||
    /(?:\.spec|\.test|\.d)\.[cm]?[jt]sx?$|\.tsbuildinfo$/.test(name) ||
    /(?:^|\/)(?:local\.settings|deploymentdata|host|function|runtime-metadata)\.json$/i.test(
      name
    ) ||
    /\.generated\.[^/]+$/i.test(name) ||
    /^(?:packages|rayfin)\/functions\/src\/types\.ts$/.test(name) ||
    /^rayfin\/connectors\/.*\/(?:metadata\.json|schema\.ts)$/.test(name) ||
    templateFiles.has(name)
  );
}

// Map a workspace-relative source path to a blueprint family, or null when it is
// not app source. The app spans several workspace packages: the browser
// application in `packages/frontend`, shared contracts in `packages/shared`,
// owned records in `packages/data` (and `rayfin/`), opt-in server code in
// `packages/functions`, and Fabric/connector config under `rayfin/`.
export function classifyActivityPath(path: string): ActivityFamily | null {
  const name = normalized(path);
  if (ignoreActivityPath(name)) return null;
  if (
    name !== CONNECTOR_CONFIG &&
    !SOURCE_ROOTS.some((root) => name.startsWith(root))
  )
    return null;
  if (
    !/\.(?:[cm]?[jt]sx?|json|ya?ml|dax|css|sql|py|cs)$/i.test(name) ||
    /(?:^|\/)(?:package(?:-lock)?|tsconfig(?:\.[\w-]+)?)\.json$/.test(name)
  )
    return null;
  if (name.endsWith('.css')) return 'styling';
  // Owned records, trusted server code, and Fabric/connector config.
  if (name.startsWith('packages/data/') || name.startsWith('rayfin/data/'))
    return 'data';
  if (
    name.startsWith('packages/functions/') ||
    name.startsWith('rayfin/functions/')
  )
    return 'actions';
  if (name.startsWith('rayfin/connectors/') || name === 'rayfin/rayfin.yml')
    return 'connections';
  // The browser application lives in packages/frontend/src.
  if (name.startsWith('packages/frontend/src/')) {
    const fe = name.slice('packages/frontend/'.length);
    if (fe.startsWith('src/queries/') || fe.endsWith('.dax')) return 'reads';
    if (
      fe === 'src/App.tsx' ||
      /^src\/(?:components|pages|routes|views)\//.test(fe)
    )
      return 'screens';
    if (/^src\/(?:lib|hooks)\//.test(fe)) return 'logic';
    // Fallbacks so arbitrary feature folders stay visible: JSX reads as a screen,
    // other TypeScript reads as logic. Auth, generated, test and welcome files
    // are already excluded above by ignoreActivityPath.
    if (/\.(?:[cm]?jsx|tsx)$/.test(fe)) return 'screens';
    if (/\.(?:[cm]?[jt]s)$/.test(fe)) return 'logic';
    return null;
  }
  // The shared package holds isomorphic contracts and logic.
  if (name.startsWith('packages/shared/src/')) return 'logic';
  return null;
}

const technical =
  /\b(?:typecheck\w*|lint\w*|vite|npm|npx|pnpm|yarn|bun|dax|sandbox\w*|containers?|mcp|widgets?|harness|rayfin|typescript|tsx|jsx|localhost|http|sdk|api|cli|sql|node_modules|packages?|dependencies|react|zod|recharts|lucide)\b/i;
const sensitive =
  /\b(?:bearer|token|secret|password|credential|authorization|cookie|api[-_ ]?key)\b|SECRET_VALUE|PRIVATE_[A-Z_]+/i;

function connectorLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.replace(/\s+/g, ' ').trim();
  // Connector names may be camelCase, unlike prose. Never copy configuration.
  return label &&
    label.length <= 100 &&
    /^[\p{L}\p{N} ()&.'_-]+$/u.test(label) &&
    !technical.test(label) &&
    !sensitive.test(label) &&
    !label.includes('@')
    ? label
    : null;
}

// Aliases like `contosoRetailSales` or `retail_sales` read as words on the
// blueprint when no display name is configured.
function humanizeIdentifier(name: string): string {
  return name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) =>
      word === word.toUpperCase() ? word : word[0].toUpperCase() + word.slice(1)
    )
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

// Null means incomplete/invalid input, never an authoritative deletion.
export function parseActivityConnectors(
  yaml: string
): ActivityConnector[] | null {
  if (yaml.length > Number(MAX_HASHED_BYTES)) return null;
  try {
    const document = parseDocument(yaml);
    if (document.errors.length) return null;
    const config: unknown = document.toJS({ maxAliasCount: 50 });
    if (!isRecord(config)) return null;
    if (!Object.hasOwn(config, 'connectors')) return [];
    const raw = config.connectors;
    const entries = Array.isArray(raw)
      ? raw
      : isRecord(raw)
        ? Object.entries(raw).map(([name, value]) =>
            isRecord(value) ? { name, ...value } : null
          )
        : null;
    if (!entries) return null;
    const validated: (Record<string, unknown> & { name: string })[] = [];
    for (const entry of entries) {
      if (
        !isRecord(entry) ||
        typeof entry.name !== 'string' ||
        !entry.name.trim()
      )
        return null;
      validated.push({ ...entry, name: entry.name });
    }
    if (new Set(validated.map(({ name }) => name)).size !== validated.length)
      return null;
    return validated.map(({ connector, type, ...entry }) => ({
      name: entry.name,
      label:
        connectorLabel(
          entry.displayName ??
            (isRecord(entry.config) ? entry.config.displayName : undefined)
        ) ??
        connectorLabel(humanizeIdentifier(entry.name)) ??
        connectorLabel(entry.name),
      fingerprint: sha(
        JSON.stringify(canonical({ ...entry, type: type ?? connector }))
      ),
    }));
  } catch {
    // Invalid aliases or shapes are surfaced by the feed as unavailable.
    return null;
  }
}

function unchangedScaffold(path: string, source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim();
  if (path === 'packages/frontend/src/App.tsx') {
    return /^import\s*\{\s*EmptyStatePreview\s*\}\s*from\s*['"]\.\/EmptyStatePreview['"];?\s*function\s+App\(\)\s*\{\s*return\s+<EmptyStatePreview\s*\/>;?\s*\}\s*export\s+default\s+App;?$/.test(
      code
    );
  }
  if (path === 'packages/data/src/index.ts') {
    // The stock data package re-exports the shared schema type and an empty list.
    return /^export\s+type\s*\{\s*UniversalAppSchema\s*\}\s+from\s*['"]@rayfin-app\/shared['"];?\s*export\s+const\s+schema\s*=\s*\[\s*\];?$/.test(
      code
    );
  }
  // packages/shared/src/index.ts: the stock isomorphic schema contract.
  return /^export\s+type\s+UniversalAppSchema\s*=\s*Record<string,\s*never>;?$/.test(
    code
  );
}

function sha(buffer: string | Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// Evaluate a single path against the index rules. Never follows symlinks, never
// returns file contents, and treats a missing file as a deletion signal. A
// `connectors` result is a set of connector entries reconciled together; a
// `stock` result is unbuilt scaffold that must not be counted; a `skip` result
// leaves the index untouched. ENOENT is expected (deletion race); anything else
// throws so the caller can surface it.
async function inspectSourcePath(
  root: string,
  rel: string
): Promise<BigIntStats | null> {
  const parts = normalized(rel).split('/');
  if (isAbsolute(rel) || parts.some((part) => part === '..' || part === '.'))
    return null;
  let path = root;
  let stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) return null;
    if (index < parts.length - 1 && !stat.isDirectory()) return null;
  }
  return stat;
}

function missingEntry(name: string): EntryResult {
  return name === CONNECTOR_CONFIG
    ? { kind: 'connectors', entries: new Map() }
    : { kind: 'missing' };
}

async function readEntry(
  root: string,
  rel: string,
  read: SourceReader = readFile
): Promise<EntryResult> {
  const name = normalized(rel);
  if (!name || ignoreActivityPath(name)) return { kind: 'skip' };
  const family = classifyActivityPath(name);
  if (!family) return { kind: 'skip' };
  try {
    const stat = await inspectSourcePath(root, name);
    if (!stat?.isFile()) return missingEntry(name);
    return await readEntryContent(root, name, family, stat, read);
  } catch (error) {
    if (hasCode(error, 'ENOENT', 'ENOTDIR')) return missingEntry(name);
    throw error;
  }
}

async function readEntryContent(
  root: string,
  name: string,
  family: ActivityFamily,
  stat: BigIntStats,
  read: SourceReader
): Promise<EntryResult> {
  if (name === CONNECTOR_CONFIG) {
    if (stat.size > MAX_HASHED_BYTES) return { kind: 'invalid-connectors' };
    const connectors = parseActivityConnectors(
      await read(join(root, name), 'utf8')
    );
    if (connectors === null) return { kind: 'invalid-connectors' };
    const entries = new Map<string, ActivityEntry>();
    for (const connector of connectors) {
      entries.set(`connector:${connector.name}`, {
        family,
        fingerprint: connector.fingerprint,
        label: connector.label,
      });
    }
    return { kind: 'connectors', entries };
  }

  if (name === 'packages/frontend/src/global.css') {
    if (stat.size <= MAX_HASHED_BYTES) {
      const fingerprint = sha(await read(join(root, name)));
      // Unchanged stock theme: recommended edit target, but not authored yet.
      if (fingerprint === STOCK_GLOBAL_CSS_SHA) return { kind: 'stock' };
      return { kind: 'file', key: name, entry: { family, fingerprint } };
    }
    return {
      kind: 'file',
      key: name,
      entry: {
        family,
        fingerprint: `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
      },
    };
  }

  if (
    [
      'packages/frontend/src/App.tsx',
      'packages/data/src/index.ts',
      'packages/shared/src/index.ts',
    ].includes(name) &&
    stat.size < 64_000n
  ) {
    const source = await read(join(root, name), 'utf8');
    if (unchangedScaffold(name, source))
      return {
        kind: 'stock',
        welcome: name === 'packages/frontend/src/App.tsx',
      };
    return {
      kind: 'file',
      key: name,
      entry: { family, fingerprint: sha(Buffer.from(source)) },
    };
  }

  // Some filesystems stamp mtime with a coarse clock, so two same-size writes in
  // one tick can collide on stat alone. Hash content for ordinary source files;
  // fall back to stat for anything too large to hash.
  const fingerprint =
    stat.size <= MAX_HASHED_BYTES
      ? sha(await read(join(root, name)))
      : `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  return { kind: 'file', key: name, entry: { family, fingerprint } };
}

// Full one-time baseline walk. Symlinks are refused, excluded and generated
// subtrees are skipped, ordinary files are content hashed. Deletion races are
// tolerated; anything else is surfaced.
function isSourceDirectory(name: string): boolean {
  return (
    !name ||
    name === 'rayfin' ||
    SOURCE_ROOTS.some(
      (root) => root.startsWith(`${name}/`) || `${name}/`.startsWith(root)
    )
  );
}

export async function collectSourceActivity(
  root: string
): Promise<ActivityCollection> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('App directory is unavailable');
  const files = new Map<string, ActivityEntry>();
  let welcome = false;
  let invalidConnectors = false;
  async function visit(relativePath: string): Promise<void> {
    if (
      relativePath &&
      !(await inspectSourcePath(root, relativePath))?.isDirectory()
    )
      return;
    const entries = await readdir(join(root, relativePath), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || ignoreActivityPath(name)) continue;
      try {
        if (entry.isDirectory()) {
          if (isSourceDirectory(name)) await visit(name);
          continue;
        }
        const result = await readEntry(root, name);
        if (result.kind === 'file') files.set(result.key, result.entry);
        else if (result.kind === 'connectors')
          for (const [key, value] of result.entries) files.set(key, value);
        else if (result.kind === 'stock' && result.welcome) welcome = true;
        else if (result.kind === 'invalid-connectors') invalidConnectors = true;
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
  }
  await visit('');
  return { files, welcome, invalidConnectors };
}

// A same-origin, development-only feed with an incremental index. The Vite plugin
// notifies it of watcher paths; a coalesced background drain processes only those
// paths, so a single edit costs one file, never a whole-tree rehash. Reads never
// block on the baseline scan: until the baseline finishes, `read()` returns null
// (the plugin serves an honest "initializing" response and the page stays
// illustrative). There is no agent, no completion signal, and no host coupling.
export function createSourceActivityFeed({
  root = process.env.PROJECT_ROOT ?? process.cwd(),
  now = Date.now,
  collect = collectSourceActivity,
  read = readFile,
}: SourceActivityOptions = {}) {
  root = resolve(root);
  let index = new Map<string, ActivityEntry>();
  let changes: ActivityChange[] = [];
  let recency: Partial<Record<ActivityFamily, string>> = {};
  let session = randomUUID();
  let nextId = 0;
  let welcome = false;
  let phase: 'idle' | 'baseline' | 'ready' = 'idle';
  let fatal: unknown = null;
  let closed = false;
  let baselinePromise: Promise<void> | null = null;
  let draining: Promise<void> | null = null;
  let fullRescan = false;
  let invalidConnectors = false;
  let published: ActivitySnapshot | null = null;
  const dirtyPaths = new Set<string>();

  const iso = () => new Date(now()).toISOString();

  function record(family: ActivityFamily, kind: ChangeKind) {
    const at = iso();
    changes.unshift({ id: `${session}:${nextId++}`, family, kind, at });
    if (changes.length > MAX_CHANGES) changes.pop();
    recency[family] = at;
  }

  function toRel(pathLike: unknown) {
    const value = String(pathLike ?? '');
    return normalized(isAbsolute(value) ? relative(root, value) : value);
  }

  function apply(name: string, result: EntryResult) {
    if (name === 'packages/frontend/src/App.tsx')
      welcome = result.kind === 'stock' && result.welcome === true;
    if (result.kind === 'invalid-connectors') {
      invalidConnectors = true;
      return;
    }
    if (result.kind === 'connectors') {
      invalidConnectors = false;
      for (const [key, entry] of result.entries) {
        const previous = index.get(key);
        index.set(key, entry);
        if (!previous) record('connections', 'add');
        else if (previous.fingerprint !== entry.fingerprint)
          record('connections', 'update');
      }
      for (const key of [...index.keys()]) {
        if (key.startsWith('connector:') && !result.entries.has(key)) {
          index.delete(key);
          record('connections', 'delete');
        }
      }
      return;
    }
    if (result.kind === 'file') {
      const previous = index.get(result.key);
      index.set(result.key, result.entry);
      if (!previous) record(result.entry.family, 'add');
      else if (previous.fingerprint !== result.entry.fingerprint)
        record(result.entry.family, 'update');
      return;
    }
    // skip | stock | missing: the path should not be indexed. If it was, that is
    // a deletion (including a file reverted to its stock scaffold).
    const previous = index.get(name);
    if (previous) {
      index.delete(name);
      record(previous.family, 'delete');
    }
  }

  function reconcileFull(collected: ActivityCollection) {
    invalidConnectors = collected.invalidConnectors === true;
    if (invalidConnectors) {
      for (const [key, entry] of index) {
        if (key.startsWith('connector:')) collected.files.set(key, entry);
      }
    }
    for (const [key, entry] of collected.files) {
      const previous = index.get(key);
      if (!previous) record(entry.family, 'add');
      else if (previous.fingerprint !== entry.fingerprint)
        record(entry.family, 'update');
    }
    for (const [key, entry] of index) {
      if (!collected.files.has(key)) record(entry.family, 'delete');
    }
    index = collected.files;
    welcome = collected.welcome;
  }

  function drain(): Promise<void> {
    if (draining) return draining;
    const running = (async () => {
      try {
        while (!closed && (dirtyPaths.size > 0 || fullRescan)) {
          if (fullRescan) {
            fullRescan = false;
            const collected = await collect(root);
            if (closed) return;
            reconcileFull(collected);
            published = snapshot();
            continue;
          }
          // Snapshot the current dirty set; paths added while this batch runs are
          // picked up on the next loop, so an edit during in-flight work is not lost.
          const batch = [...dirtyPaths];
          dirtyPaths.clear();
          for (const rel of batch) {
            if (closed) return;
            const result = await readEntry(root, rel, read);
            if (closed) return;
            apply(rel, result);
          }
          published = snapshot();
        }
      } catch (error) {
        fatal = error;
        throw error;
      }
    })();
    // Clear the handle only once this run settles. Attaching the reset here (not
    // in an inner `finally`) avoids a race where a synchronously-completing drain
    // would null the handle before it was even assigned, stranding later paths.
    draining = running.finally(() => {
      draining = null;
    });
    return draining;
  }

  function scheduleDrain() {
    if (phase !== 'ready' || closed) return Promise.resolve();
    const pending = drain();
    // read() surfaces the stored failure; event emitters do not await promises.
    void pending.catch(() => {});
    return pending;
  }

  async function runBaseline() {
    phase = 'baseline';
    const collected = await collect(root);
    if (closed) return;
    index = collected.files;
    welcome = collected.welcome;
    invalidConnectors = collected.invalidConnectors === true;
    published = snapshot();
    phase = 'ready';
    // Process anything that changed while the baseline was running.
    await drain();
  }

  function start() {
    if (!baselinePromise) {
      baselinePromise = runBaseline();
      void baselinePromise.catch((error) => {
        fatal = error;
      });
    }
    return baselinePromise;
  }

  function snapshot(): ActivitySnapshot {
    const counts = Object.fromEntries(
      ACTIVITY_FAMILIES.map((family) => [family, 0])
    );
    const names = new Set<string>();
    for (const entry of index.values()) {
      counts[entry.family] += 1;
      if (entry.family === 'connections' && entry.label) names.add(entry.label);
    }
    return {
      structure: ACTIVITY_FAMILIES.map((family) => ({
        family,
        count: counts[family],
        lastChangedAt: recency[family] ?? null,
        ...(family === 'connections'
          ? { names: [...names].slice(0, 100) }
          : {}),
      })),
      changes: changes.map((change) => ({ ...change })),
      generatedAt: iso(),
      welcome,
    };
  }

  return {
    start,
    // Notify of a single changed file path (absolute or root-relative).
    notifyPath(pathLike: string) {
      if (closed) return Promise.resolve();
      dirtyPaths.add(toRel(pathLike));
      return scheduleDrain();
    },
    // Directory events reconcile additions and deletions even without file events.
    notifyDir(pathLike: string) {
      const rel = toRel(pathLike);
      if (closed || ignoreActivityPath(rel) || !isSourceDirectory(rel))
        return Promise.resolve();
      // A directory event can cover newly added files and synthetic connector keys.
      fullRescan = true;
      return scheduleDrain();
    },
    // The watcher itself failed: fall back to a full reconcile.
    notifyAll() {
      if (closed) return Promise.resolve();
      fullRescan = true;
      return scheduleDrain();
    },
    async reset() {
      if (draining) await draining.catch(() => {});
      if (baselinePromise) await baselinePromise.catch(() => {});
      changes = [];
      recency = {};
      nextId = 0;
      session = randomUUID();
      index = new Map();
      welcome = false;
      phase = 'idle';
      fatal = null;
      invalidConnectors = false;
      published = null;
      fullRescan = false;
      dirtyPaths.clear();
      baselinePromise = null;
      return start();
    },
    async read() {
      if (closed) throw new Error('Source activity feed is closed');
      if (fatal) throw fatal;
      if (phase !== 'ready') {
        start();
        return null;
      }
      if (invalidConnectors)
        throw new Error(
          'Connector activity is unavailable until rayfin.yml is valid.'
        );
      if (!published)
        throw new Error('Source activity snapshot is unavailable');
      return {
        ...published,
        structure: published.structure.map((area) => ({
          ...area,
          ...(area.names ? { names: [...area.names] } : {}),
        })),
        changes: published.changes.map((change) => ({ ...change })),
        generatedAt: iso(),
      };
    },
    close() {
      closed = true;
    },
  };
}
// Path helpers shared with the plugin so the endpoint honours the Vite base.
export function activityRoutePath(base = '/') {
  return `${base.endsWith('/') ? base : `${base}/`}@fabric-app/source-activity`;
}

export function isActivityRequest(url: string | undefined, base = '/') {
  const path = String(url ?? '').split(/[?#]/, 1)[0];
  return (
    path === activityRoutePath(base) ||
    path.endsWith('/@fabric-app/source-activity')
  );
}
