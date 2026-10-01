//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll as after, test, vi } from 'vitest';
import { fileURLToPath, URL } from 'node:url';

import {
  activityRoutePath,
  classifyActivityPath,
  collectSourceActivity,
  createSourceActivityFeed,
  ignoreActivityPath,
  isActivityRequest,
  parseActivityConnectors,
} from '../source-activity.js';
import { attachSourceActivity } from '../source-activity-vite.js';
import { rayfinLocalDev } from '../vite.js';

vi.mock('@microsoft/rayfin-cli/auth', () => ({
  getAuthenticatedToken: vi.fn(),
}));

// The feed roots at the app workspace, so all paths below are workspace-relative:
// the browser app lives under `packages/frontend/src`, siblings under
// `packages/shared` and `packages/data`, and backend config under `rayfin/`.
const FE = 'packages/frontend/src';

const roots = [];
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'source-activity-'));
  roots.push(root);
  await mkdir(join(root, FE, 'components'), { recursive: true });
  await mkdir(join(root, FE, 'lib'), { recursive: true });
  await mkdir(join(root, 'packages', 'shared', 'src'), { recursive: true });
  await mkdir(join(root, 'packages', 'data', 'src'), { recursive: true });
  await mkdir(join(root, 'rayfin', 'data'), { recursive: true });
  return root;
}
async function put(root, rel, content) {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (snapshot, family) =>
  snapshot.structure.find((entry) => entry.family === family).count;

// The stock global.css whose content hash is pinned in the scanner. Reading the
// real file keeps the test honest if the shipped theme (and the pin) ever change.
const stockGlobalCss = await readFile(
  fileURLToPath(
    new URL(
      '../../../../../samples/universal-app/template/packages/frontend/src/global.css',
      import.meta.url
    )
  ),
  'utf8'
);

function connectorsYaml(entries) {
  const lines = ['connectors:'];
  for (const entry of entries) {
    lines.push(`  - name: ${entry.name}`);
    if (entry.display) lines.push(`    displayName: ${entry.display}`);
  }
  return `${lines.join('\n')}\n`;
}

test('classifies workspace source paths across frontend and sibling packages', () => {
  // Frontend application.
  assert.equal(classifyActivityPath(`${FE}/App.tsx`), 'screens');
  assert.equal(classifyActivityPath(`${FE}/components/Card.tsx`), 'screens');
  assert.equal(classifyActivityPath(`${FE}/pages/Dashboard.tsx`), 'screens');
  assert.equal(classifyActivityPath(`${FE}/routes/Home.tsx`), 'screens');
  assert.equal(classifyActivityPath(`${FE}/views/List.tsx`), 'screens');
  assert.equal(
    classifyActivityPath(`${FE}/features/Widget/Widget.tsx`),
    'screens'
  );
  assert.equal(classifyActivityPath(`${FE}/state/store.ts`), 'logic');
  assert.equal(classifyActivityPath(`${FE}/lib/calc.ts`), 'logic');
  assert.equal(classifyActivityPath(`${FE}/services/orders.ts`), 'logic');
  assert.equal(classifyActivityPath(`${FE}/services/orders/read.ts`), 'logic');
  assert.equal(
    classifyActivityPath(`${FE}/services/rayfin-auth.service.custom.ts`),
    'logic'
  );
  assert.equal(classifyActivityPath(`${FE}/queries/orders.ts`), 'reads');
  assert.equal(classifyActivityPath(`${FE}/global.css`), 'styling');
  assert.equal(classifyActivityPath(`${FE}/components/Card.css`), 'styling');
  // Sibling workspace packages and backend config.
  assert.equal(
    classifyActivityPath('packages/shared/src/contract.ts'),
    'logic'
  );
  assert.equal(classifyActivityPath('packages/data/src/entities.ts'), 'data');
  assert.equal(classifyActivityPath('rayfin/data/schema.ts'), 'data');
  assert.equal(
    classifyActivityPath('packages/functions/src/notify.ts'),
    'actions'
  );
  assert.equal(classifyActivityPath('rayfin/functions/handler.ts'), 'actions');
  assert.equal(
    classifyActivityPath('rayfin/connectors/sales.ts'),
    'connections'
  );
  assert.equal(classifyActivityPath('rayfin/rayfin.yml'), 'connections');
});

test('ignores dependencies, output, tests, generated files, the welcome surface and bootstrap', () => {
  for (const path of [
    'node_modules/react/index.js',
    'packages/frontend/dist/app.js',
    'coverage/report.json',
    '.env',
    `${FE}/App.spec.tsx`,
    `${FE}/vite-env.d.ts`,
    `${FE}/Welcome.tsx`,
    `${FE}/Welcome.activity.ts`,
    `${FE}/Finley.tsx`,
    `${FE}/Finley.css`,
    `${FE}/FabricAppMark.tsx`,
    `${FE}/ErrorFallback.tsx`,
    `${FE}/EmptyStatePreview.tsx`,
    `${FE}/main.tsx`,
    `${FE}/Root.tsx`,
    `${FE}/services/rayfin-auth.service.ts`,
    `${FE}/services/orders.spec.ts`,
    `${FE}/hooks/use-auth.tsx`,
    `${FE}/lib/rayfin-client.ts`,
    'packages/functions/local.settings.json',
    'packages/functions/deploymentdata.json',
    'packages/functions/src/types.ts',
    'packages/functions/src/fabric.generated.ts',
    'rayfin/connectors/orders/metadata.json',
    'rayfin/connectors/orders/schema.ts',
  ]) {
    assert.equal(
      ignoreActivityPath(path),
      true,
      `expected ${path} to be ignored`
    );
    assert.equal(
      classifyActivityPath(path),
      null,
      `expected ${path} unclassified`
    );
  }
  for (const path of [
    'package.json',
    'package-lock.json',
    'packages/frontend/tsconfig.app.json',
    'docs/style.css',
  ]) {
    assert.equal(
      classifyActivityPath(path),
      null,
      `expected ${path} unclassified`
    );
  }
});

test('reports a baseline snapshot without changes, then adds, updates and deletes incrementally', async () => {
  const root = await makeRoot();
  await put(
    root,
    `${FE}/components/Home.tsx`,
    'export const Home = () => null;'
  );
  const feed = createSourceActivityFeed({ root });

  assert.equal(await feed.read(), null);
  await feed.start();

  const base = await feed.read();
  assert.equal(base.changes.length, 0);
  assert.equal(count(base, 'screens'), 1);
  assert.deepEqual(Object.keys(base).sort(), [
    'changes',
    'generatedAt',
    'structure',
    'welcome',
  ]);

  await put(root, `${FE}/lib/total.ts`, 'export const total = 1;');
  await feed.notifyPath(`${FE}/lib/total.ts`);
  let snap = await feed.read();
  assert.equal(snap.changes[0].family, 'logic');
  assert.equal(snap.changes[0].kind, 'add');

  await put(root, `${FE}/lib/total.ts`, 'export const total = 2;');
  await feed.notifyPath(`${FE}/lib/total.ts`);
  snap = await feed.read();
  assert.equal(snap.changes[0].kind, 'update');

  await rm(join(root, `${FE}/lib/total.ts`));
  await feed.notifyPath(`${FE}/lib/total.ts`);
  snap = await feed.read();
  assert.equal(snap.changes[0].kind, 'delete');
  assert.equal(count(snap, 'logic'), 0);
  feed.close();
});

test('observes edits in sibling workspace packages and backend config', async () => {
  const root = await makeRoot();
  const feed = createSourceActivityFeed({ root });
  await feed.start();

  await put(
    root,
    'packages/shared/src/contract.ts',
    'export const version = 1;'
  );
  await feed.notifyPath('packages/shared/src/contract.ts');
  let snap = await feed.read();
  assert.equal(count(snap, 'logic'), 1);
  assert.ok(snap.changes.some((c) => c.family === 'logic' && c.kind === 'add'));

  await put(root, 'packages/data/src/orders.ts', 'export const orders = [];');
  await feed.notifyPath('packages/data/src/orders.ts');
  snap = await feed.read();
  assert.equal(count(snap, 'data'), 1);

  await put(
    root,
    'packages/functions/src/notify.ts',
    'export const notify = () => {};'
  );
  await feed.notifyPath('packages/functions/src/notify.ts');
  snap = await feed.read();
  assert.equal(count(snap, 'actions'), 1);
  feed.close();
});

test('tracks authored services in the baseline and edit feed while excluding stock auth', async () => {
  const root = await makeRoot();
  const authPath = `${FE}/services/rayfin-auth.service.ts`;
  const servicePath = `${FE}/services/orders.ts`;
  const nestedPath = `${FE}/services/orders/read.ts`;
  await put(root, authPath, 'export const authVersion = 1;');
  await put(root, servicePath, 'export const version = 1;');
  const feed = createSourceActivityFeed({ root });

  try {
    await feed.start();
    let snapshot = await feed.read();
    assert.equal(count(snapshot, 'logic'), 1);
    assert.deepEqual(snapshot.changes, []);

    await put(root, authPath, 'export const authVersion = 2;');
    await feed.notifyPath(authPath);
    snapshot = await feed.read();
    assert.equal(count(snapshot, 'logic'), 1);
    assert.deepEqual(snapshot.changes, []);

    await put(root, servicePath, 'export const version = 2;');
    await feed.notifyPath(servicePath);
    snapshot = await feed.read();
    assert.equal(count(snapshot, 'logic'), 1);
    assert.equal(snapshot.changes[0].family, 'logic');
    assert.equal(snapshot.changes[0].kind, 'update');

    await put(root, nestedPath, 'export const ready = true;');
    await feed.notifyPath(nestedPath);
    snapshot = await feed.read();
    assert.equal(count(snapshot, 'logic'), 2);
    assert.equal(snapshot.changes[0].family, 'logic');
    assert.equal(snapshot.changes[0].kind, 'add');

    await rm(join(root, servicePath));
    await feed.notifyPath(servicePath);
    snapshot = await feed.read();
    assert.equal(count(snapshot, 'logic'), 1);
    assert.equal(snapshot.changes[0].family, 'logic');
    assert.equal(snapshot.changes[0].kind, 'delete');
  } finally {
    feed.close();
  }
});

test('does not block reads on a slow baseline scan', async () => {
  const root = await makeRoot();
  await put(root, `${FE}/components/A.tsx`, 'export const A = () => null;');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const feed = createSourceActivityFeed({
    root,
    collect: async (r) => {
      await gate;
      return collectSourceActivity(r);
    },
  });

  const started = feed.start();
  assert.equal(await feed.read(), null);
  release();
  await started;
  assert.equal(count(await feed.read(), 'screens'), 1);
  feed.close();
});

test('updates a single file without rescanning the whole tree', async () => {
  const root = await makeRoot();
  await put(
    root,
    `${FE}/components/Home.tsx`,
    'export const Home = () => null;'
  );
  let scans = 0;
  const feed = createSourceActivityFeed({
    root,
    collect: async (r) => {
      scans += 1;
      return collectSourceActivity(r);
    },
  });
  await feed.start();
  assert.equal(scans, 1, 'exactly one baseline scan');

  await put(root, `${FE}/lib/total.ts`, 'export const total = 1;');
  await feed.notifyPath(`${FE}/lib/total.ts`);
  const snap = await feed.read();
  assert.equal(
    scans,
    1,
    'an incremental update must not rehash the whole tree'
  );
  assert.equal(snap.changes[0].family, 'logic');
  feed.close();
});

test('does not lose an update that arrives while a read is draining', async () => {
  const root = await makeRoot();
  const feed = createSourceActivityFeed({ root });
  await feed.start();

  await put(root, `${FE}/lib/a.ts`, 'export const a = 1;');
  await put(root, `${FE}/lib/b.ts`, 'export const b = 1;');
  const first = feed.notifyPath(`${FE}/lib/a.ts`);
  const pending = feed.read();
  const second = feed.notifyPath(`${FE}/lib/b.ts`);
  await pending;
  await Promise.all([first, second]);

  const snap = await feed.read();
  assert.equal(count(snap, 'logic'), 2);
  assert.equal(
    snap.changes.filter((c) => c.family === 'logic' && c.kind === 'add').length,
    2
  );
  feed.close();
});

test('detects a same-size edit by content, and ignores an identical rewrite', async () => {
  const root = await makeRoot();
  await put(root, `${FE}/lib/rate.ts`, 'export const rate = 11;');
  const feed = createSourceActivityFeed({ root });
  await feed.start();

  await put(root, `${FE}/lib/rate.ts`, 'export const rate = 22;');
  await feed.notifyPath(`${FE}/lib/rate.ts`);
  let snap = await feed.read();
  assert.equal(snap.changes.length, 1);
  assert.equal(snap.changes[0].kind, 'update');

  await put(root, `${FE}/lib/rate.ts`, 'export const rate = 22;');
  await feed.notifyPath(`${FE}/lib/rate.ts`);
  snap = await feed.read();
  assert.equal(
    snap.changes.length,
    1,
    'an identical rewrite must not add a change'
  );
  feed.close();
});

test('counts global.css only once a builder edits it, and stops when reverted', async () => {
  const root = await makeRoot();
  await put(root, `${FE}/global.css`, stockGlobalCss);
  const feed = createSourceActivityFeed({ root });
  await feed.start();
  assert.equal(
    count(await feed.read(), 'styling'),
    0,
    'stock global.css is not counted'
  );

  await put(
    root,
    `${FE}/global.css`,
    `${stockGlobalCss}\n.brand { color: red; }\n`
  );
  await feed.notifyPath(`${FE}/global.css`);
  let snap = await feed.read();
  assert.equal(
    count(snap, 'styling'),
    1,
    'an edited global.css counts toward Look and feel'
  );
  assert.equal(snap.changes[0].family, 'styling');
  assert.equal(snap.changes[0].kind, 'add');

  // Restart-safe: a fresh feed over the already-edited file still sees an edit.
  const restarted = createSourceActivityFeed({ root });
  await restarted.start();
  assert.equal(count(await restarted.read(), 'styling'), 1);
  restarted.close();

  await put(root, `${FE}/global.css`, stockGlobalCss);
  await feed.notifyPath(`${FE}/global.css`);
  snap = await feed.read();
  assert.equal(
    count(snap, 'styling'),
    0,
    'reverting global.css to stock stops counting it'
  );
  assert.equal(snap.changes[0].kind, 'delete');
  feed.close();
});

test('tracks adds, updates and deletes in generic page, route and view folders', async () => {
  const root = await makeRoot();
  const feed = createSourceActivityFeed({ root });
  await feed.start();

  for (const path of [
    `${FE}/pages/Dashboard.tsx`,
    `${FE}/routes/Home.tsx`,
    `${FE}/views/List.tsx`,
    `${FE}/features/Widget/Widget.tsx`,
  ]) {
    await put(root, path, 'export default () => null;');
    await feed.notifyPath(path);
  }
  let snap = await feed.read();
  assert.equal(count(snap, 'screens'), 4);

  await put(root, `${FE}/pages/Dashboard.tsx`, 'export default () => 1;');
  await feed.notifyPath(`${FE}/pages/Dashboard.tsx`);
  snap = await feed.read();
  assert.ok(
    snap.changes.some((c) => c.family === 'screens' && c.kind === 'update')
  );

  await rm(join(root, `${FE}/routes/Home.tsx`));
  await feed.notifyPath(`${FE}/routes/Home.tsx`);
  snap = await feed.read();
  assert.equal(count(snap, 'screens'), 3);
  assert.ok(
    snap.changes.some((c) => c.family === 'screens' && c.kind === 'delete')
  );
  feed.close();
});

test('never leaks file contents, absolute paths, or secrets into the payload', async () => {
  const root = await makeRoot();
  const secret = 'SECRET_VALUE_hunter2_do_not_leak';
  await put(root, `${FE}/lib/config.ts`, `export const apiKey = '${secret}';`);
  const feed = createSourceActivityFeed({ root });
  await feed.start();
  await feed.notifyPath(`${FE}/lib/config.ts`);
  const serialized = JSON.stringify(await feed.read());
  assert.ok(
    !serialized.includes(secret),
    'payload must not contain file contents'
  );
  assert.ok(
    !serialized.includes(root),
    'payload must not contain absolute paths'
  );
  assert.ok(
    !serialized.includes('config.ts'),
    'payload must not contain file paths'
  );
  feed.close();
});

test('refuses to follow symlinks', async () => {
  const root = await makeRoot();
  await put(root, `${FE}/lib/real.ts`, 'export const real = 1;');
  let linked = false;
  try {
    await symlink(
      join(root, `${FE}/lib/real.ts`),
      join(root, `${FE}/lib/link.ts`)
    );
    linked = true;
  } catch {
    // Creating a symlink can require privileges (Windows); skip if unavailable.
  }
  const feed = createSourceActivityFeed({ root });
  await feed.start();
  assert.equal(count(await feed.read(), 'logic'), 1);
  if (linked) assert.ok(true, 'symlink present but not counted');
  feed.close();
});

test('reports the stock scaffold as unbuilt and does not count it', async () => {
  const root = await makeRoot();
  await put(
    root,
    `${FE}/App.tsx`,
    "import { EmptyStatePreview } from './EmptyStatePreview';\nfunction App() {\n  return <EmptyStatePreview />;\n}\nexport default App;\n"
  );
  await put(
    root,
    'packages/data/src/index.ts',
    "export type { UniversalAppSchema } from '@rayfin-app/shared';\nexport const schema = [];\n"
  );
  await put(
    root,
    'packages/shared/src/index.ts',
    'export type UniversalAppSchema = Record<string, never>;\n'
  );
  const feed = createSourceActivityFeed({ root });
  await feed.start();
  const snap = await feed.read();
  assert.equal(snap.welcome, true);
  assert.equal(count(snap, 'screens'), 0);
  assert.equal(count(snap, 'data'), 0);
  assert.equal(count(snap, 'logic'), 0);

  // A real edit to the data/shared contract starts counting.
  await put(
    root,
    'packages/data/src/index.ts',
    "export type { UniversalAppSchema } from '@rayfin-app/shared';\nexport const schema = [Order];\n"
  );
  await feed.notifyPath('packages/data/src/index.ts');
  assert.equal(count(await feed.read(), 'data'), 1);
  feed.close();
});

test('surfaces connector settings for the connections family and reconciles edits', async () => {
  const yaml = connectorsYaml([
    { name: 'contosoRetailSales' },
    { name: 'warehouse', display: 'Contoso Warehouse' },
  ]);
  const entries = parseActivityConnectors(yaml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].label, 'Contoso Retail Sales');
  assert.equal(entries[1].label, 'Contoso Warehouse');

  const root = await makeRoot();
  await put(root, 'rayfin/rayfin.yml', yaml);
  const feed = createSourceActivityFeed({ root });
  await feed.start();
  let snap = await feed.read();
  assert.equal(count(snap, 'connections'), 2);
  assert.deepEqual(
    snap.structure.find((s) => s.family === 'connections').names,
    ['Contoso Retail Sales', 'Contoso Warehouse']
  );

  await put(
    root,
    'rayfin/rayfin.yml',
    connectorsYaml([
      { name: 'contosoRetailSales' },
      { name: 'warehouse', display: 'Contoso Warehouse' },
      { name: 'orders' },
    ])
  );
  await feed.notifyPath('rayfin/rayfin.yml');
  snap = await feed.read();
  assert.equal(count(snap, 'connections'), 3);
  assert.ok(
    snap.changes.some((c) => c.family === 'connections' && c.kind === 'add')
  );

  await rm(join(root, 'rayfin/rayfin.yml'));
  await feed.notifyPath('rayfin/rayfin.yml');
  snap = await feed.read();
  assert.equal(count(snap, 'connections'), 0);
  assert.ok(
    snap.changes.some((c) => c.family === 'connections' && c.kind === 'delete')
  );
  feed.close();
});

test('normalizes block, flow and legacy keyed connector YAML without false changes', () => {
  const forms = [
    'connectors:\n  - name: sales\n    type: fabric-semanticmodel\n    config:\n      displayName: Sales Model\n',
    'connectors: [{name: sales, type: fabric-semanticmodel, config: {displayName: Sales Model}}]',
    'connectors:\n  sales:\n    connector: fabric-semanticmodel\n    config: {displayName: Sales Model}',
  ].map(parseActivityConnectors);
  assert.equal(forms[0][0].label, 'Sales Model');
  assert.deepEqual(forms[1], forms[0]);
  assert.deepEqual(forms[2], forms[0]);
  for (const yaml of ['connectors: []', 'connectors: {}', 'services: {}']) {
    assert.deepEqual(parseActivityConnectors(yaml), []);
  }
  for (const yaml of [
    '',
    'connectors:',
    'connectors: [',
    'connectors: nope',
    'connectors: [null]',
    'connectors: {sales: false}',
    'connectors: [{name: sales}, {name: sales}]',
  ]) {
    assert.equal(parseActivityConnectors(yaml), null, yaml);
  }
});

test('invalid connector edits surface an error without deleting the last known connections', async () => {
  const root = await makeRoot();
  const yaml = 'connectors: [{name: sales}]';
  await put(root, 'rayfin/rayfin.yml', yaml);
  const feed = createSourceActivityFeed({ root });
  await feed.start();
  await put(root, 'rayfin/rayfin.yml', 'connectors: [');
  await feed.notifyPath('rayfin/rayfin.yml');
  await assert.rejects(feed.read(), /rayfin.yml is valid/);
  await feed.notifyAll();
  await assert.rejects(feed.read(), /rayfin.yml is valid/);
  await put(root, 'rayfin/rayfin.yml', yaml);
  await feed.notifyPath('rayfin/rayfin.yml');
  const snapshot = await feed.read();
  assert.equal(count(snapshot, 'connections'), 1);
  assert.deepEqual(snapshot.changes, []);
  feed.close();
});

test('directory-only events reconcile connector deletion and newly created source', async () => {
  const root = await makeRoot();
  await put(root, 'rayfin/rayfin.yml', 'connectors: [{name: sales}]');
  const feed = createSourceActivityFeed({ root });
  await feed.start();
  await rm(join(root, 'rayfin'), { recursive: true });
  await feed.notifyDir('rayfin');
  assert.equal(count(await feed.read(), 'connections'), 0);
  await put(
    root,
    'packages/functions/src/function_app.ts',
    'export const run = 1;'
  );
  await feed.notifyDir('packages/functions');
  assert.equal(count(await feed.read(), 'actions'), 1);
  feed.close();
});

test('incremental reads reject linked ancestors, including directory junctions', async (t) => {
  const root = await makeRoot();
  const outside = await makeRoot();
  await put(
    outside,
    `${FE}/lib/private.ts`,
    'export const secret = "not application source";'
  );
  try {
    await symlink(
      join(outside, FE, 'lib'),
      join(root, FE, 'lib', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip('This environment cannot create links.');
    return;
  }
  let reads = 0;
  const feed = createSourceActivityFeed({
    root,
    read: async (...args) => {
      reads += 1;
      return readFile(...args);
    },
  });
  await feed.start();
  await feed.notifyPath(`${FE}/lib/linked/private.ts`);
  await feed.notifyDir(`${FE}/lib/linked`);
  assert.equal(count(await feed.read(), 'logic'), 0);
  assert.equal(reads, 0);
  feed.close();
});

test('an incremental save/delete race recovers when the file is recreated', async () => {
  const root = await makeRoot();
  const file = `${FE}/lib/racy.ts`;
  await put(root, file, 'export const value = 1;');
  let removeOnRead = true;
  const feed = createSourceActivityFeed({
    root,
    read: async (path, options) => {
      if (removeOnRead) {
        removeOnRead = false;
        await rm(path);
      }
      return readFile(path, options);
    },
  });
  await feed.start();
  await feed.notifyPath(file);
  assert.equal(count(await feed.read(), 'logic'), 0);
  await put(root, file, 'export const value = 2;');
  await feed.notifyPath(file);
  assert.equal(count(await feed.read(), 'logic'), 1);
  feed.close();
});

test('ready reads return a completed snapshot while reconciliation is blocked', async () => {
  const root = await makeRoot();
  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const blocked = new Promise((resolve) => {
    entered = resolve;
  });
  let scans = 0;
  const feed = createSourceActivityFeed({
    root,
    collect: async (path) => {
      if (++scans > 1) {
        entered();
        await gate;
      }
      return collectSourceActivity(path);
    },
  });
  await feed.start();
  await put(root, `${FE}/lib/new.ts`, 'export const value = 1;');
  const pending = feed.notifyAll();
  await blocked;
  try {
    const snapshot = await Promise.race([
      feed.read(),
      delay(200).then(() => {
        throw new Error('read waited for reconciliation');
      }),
    ]);
    assert.equal(count(snapshot, 'logic'), 0);
  } finally {
    release();
    await pending;
    feed.close();
  }
});

test('lazy and eager baseline failures are handled and still reach readers', async () => {
  const root = await makeRoot();
  const collect = async () => {
    throw new Error('baseline unavailable');
  };
  for (const eager of [false, true]) {
    const feed = createSourceActivityFeed({ root, collect });
    if (eager) void feed.start();
    else assert.equal(await feed.read(), null);
    await delay(10);
    await assert.rejects(feed.read(), /baseline unavailable/);
    feed.close();
  }
});

test('the Vite plugin logs a baseline failure and serves 503 without an unhandled rejection', async () => {
  const root = await makeRoot();
  const warnings = [];
  const watcher = new EventEmitter();
  watcher.add = () => {};
  const server = new EventEmitter();
  let middleware;
  const dispose = attachSourceActivity(
    {
      config: {
        root: join(root, 'packages', 'frontend'),
        base: '/',
        logger: { warn: (message) => warnings.push(message) },
      },
      watcher,
      httpServer: server,
      middlewares: {
        use: (handler) => {
          middleware = handler;
        },
      },
    },
    join(root, 'missing')
  );
  try {
    for (let tries = 0; !warnings.length && tries < 40; tries += 1)
      await delay(25);
    assert.equal(warnings.length, 1);
    let status;
    const body = await new Promise((resolve, reject) => {
      const response = {
        setHeader() {},
        end(value) {
          status = this.statusCode;
          resolve(JSON.parse(value));
        },
      };
      middleware({ url: '/@fabric-app/source-activity' }, response, () =>
        reject(new Error('Missing activity route'))
      );
    });
    assert.equal(status, 503);
    assert.equal(body.error, 'Source activity is temporarily unavailable');
    assert.equal(warnings.length, 1);
  } finally {
    server.emit('close');
    dispose();
    assert.equal(watcher.listenerCount('add'), 0);
    assert.equal(watcher.listenerCount('change'), 0);
    assert.equal(watcher.listenerCount('error'), 0);
  }
});

test('the existing local-dev plugin does not observe source activity unless opted in', () => {
  const watcher = new EventEmitter();
  const middleware = [];
  const plugin = rayfinLocalDev();
  plugin.configureServer({
    config: { root: process.cwd(), base: '/', logger: { warn() {} } },
    watcher,
    middlewares: { use: (...args) => middleware.push(args) },
  });
  assert.equal(watcher.listenerCount('add'), 0);
  assert.equal(
    middleware.some((args) => args.length === 1),
    false
  );
  plugin.closeBundle();
});

test('Vite excludes source-activity registration from production builds', async () => {
  const { resolveConfig } = await import('vite');
  const config = await resolveConfig(
    {
      configFile: false,
      logLevel: 'silent',
      plugins: [rayfinLocalDev({ sourceActivity: true })],
    },
    'build',
    'production'
  );
  assert.equal(
    config.plugins.some(({ name }) => name === 'rayfin-local-dev'),
    false
  );
});

test('replacing the welcome stops reporting the stock starting view', async () => {
  const root = await makeRoot();
  const app = `${FE}/App.tsx`;
  await put(
    root,
    app,
    "import { EmptyStatePreview } from './EmptyStatePreview';\nfunction App(){return <EmptyStatePreview />;} export default App;"
  );
  const feed = createSourceActivityFeed({ root });
  await feed.start();
  assert.equal((await feed.read()).welcome, true);
  await put(
    root,
    app,
    'export default function App(){return <main>My app</main>;}'
  );
  await feed.notifyPath(app);
  assert.equal((await feed.read()).welcome, false);
  feed.close();
});

test('endpoint matching honours the base path', () => {
  assert.equal(activityRoutePath('/'), '/@fabric-app/source-activity');
  assert.equal(
    activityRoutePath('/apps/sample/'),
    '/apps/sample/@fabric-app/source-activity'
  );
  assert.equal(
    isActivityRequest(
      '/apps/sample/@fabric-app/source-activity',
      '/apps/sample/'
    ),
    true
  );
  assert.equal(
    isActivityRequest('/@fabric-app/source-activity?t=1', '/'),
    true
  );
  assert.equal(isActivityRequest('/index.html', '/'), false);
});

// Real Vite: run the dev server in the frontend package and prove that both a
// frontend edit and a sibling edit OUTSIDE the frontend's Vite root reach the
// feed through the plugin's explicit sibling watch. Polling watch keeps detection
// reliable.
test('serves the feed over a real Vite dev server and reacts to frontend and sibling edits', async () => {
  const vite = await import('vite');
  const root = await makeRoot();
  const frontendRoot = resolve(root, 'packages', 'frontend');
  await put(
    root,
    `${FE}/components/Start.tsx`,
    'export const Start = () => null;'
  );

  const server = await vite.createServer({
    root: frontendRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [rayfinLocalDev({ sourceActivity: true })],
    server: { middlewareMode: true, watch: { usePolling: true, interval: 60 } },
  });
  const listener = createServer(server.middlewares);
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  const url = `http://127.0.0.1:${port}/@fabric-app/source-activity`;

  const pollFor = async (predicate) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(100);
      const response = await fetch(url);
      if (response.ok) {
        const snap = await response.json();
        if (predicate(snap)) return snap;
      }
    }
    return null;
  };

  try {
    const baseline = await pollFor((snap) => count(snap, 'screens') >= 1);
    assert.ok(
      baseline,
      'expected the baseline frontend screen to become ready'
    );

    // A frontend edit inside the Vite root.
    await put(
      root,
      `${FE}/components/Panel.tsx`,
      'export const Panel = () => null;'
    );
    assert.ok(
      await pollFor((snap) => count(snap, 'screens') >= 2),
      'frontend edit not observed'
    );

    // A sibling edit OUTSIDE the frontend's Vite root, reached via the plugin's
    // explicit sibling watch.
    await put(root, 'packages/data/src/orders.ts', 'export const orders = [];');
    const detected = await pollFor(
      (snap) =>
        count(snap, 'data') >= 1 &&
        snap.changes.some((c) => c.family === 'data' && c.kind === 'add')
    );
    assert.ok(
      detected,
      'expected the sibling data edit outside the Vite root to be observed'
    );
    assert.equal(count(baseline, 'actions'), 0);
    await put(
      root,
      'packages/functions/src/function_app.ts',
      'export const action = () => "result";'
    );
    assert.ok(
      await pollFor(
        (snap) =>
          count(snap, 'actions') === 1 &&
          snap.changes.some(
            (change) => change.family === 'actions' && change.kind === 'add'
          )
      ),
      'optional functions created after startup were not observed'
    );
    await rm(join(root, 'packages', 'functions'), { recursive: true });
    assert.ok(
      await pollFor((snap) => count(snap, 'actions') === 0),
      'optional functions removed after startup were not observed'
    );
  } finally {
    await server.close();
    await new Promise((resolve) => listener.close(resolve));
  }
}, 30_000);
