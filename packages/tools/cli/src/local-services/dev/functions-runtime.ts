/**
 * Host-local primitives for the Rayfin functions development runtime.
 *
 * This service owns Node-specific mechanics that both the compatibility
 * `dev functions apply` command and the workflow-based `dev` session can compose. It stays
 * output-free: Layer 1 owns prompts, rendering, and process supervision.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';

import type { CancellationToken } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type { LocalRuntimeSpec } from '@microsoft/rayfin-tools-common/_internal/workflows/dev';

import { isWindows, terminateProcessTree } from '../../utils/platform-utils.js';

export const DEFAULT_FUNCTIONS_PORT = '7071';
export const DEFAULT_FUNCTIONS_INSPECT_PORT = '9229';
export const FUNCTIONS_BUILD_WATCH_WARNING =
  'No build:watch script in the functions package. Continuing without automatic recompilation. Add "build:watch": "tsc --build --watch" (or your compiler\'s watch command) to package.json to enable it.';
const FUNCTIONS_PORT_SCAN_WINDOW = 8;

export interface FunctionsTypegenSession {
  /** Initial generation failure; the watcher still starts and retries on edit. */
  initialError?: Error;
  /** Idempotently stop the source watcher. */
  close(): void;
}

export type FunctionsDebuggerConfigResult =
  | { status: 'not-ready' }
  | { status: 'written' | 'unchanged'; path: string }
  | { status: 'updated'; path: string; port: number }
  | { status: 'invalid-json'; path: string };

export interface FunctionsPortSearchResult {
  port: number | null;
  searched: { from: number; to: number };
}

export interface LocalFunctionsRuntimeService {
  /** Find the first free loopback port in the bounded range. */
  findAvailablePort(
    startPort: number,
    windowSize?: number
  ): Promise<FunctionsPortSearchResult>;
  /** Merge CLI-managed values into `local.settings.json`. */
  upsertLocalSettings(
    functionsDir: string,
    values: Record<string, string>
  ): Promise<void>;
  /** Build the Core Tools CORS allow-list for the local frontend. */
  resolveCorsOrigins(config: RayfinConfig | null | undefined): string[];
  /** Prepare the package's compiler watcher, or return undefined when no script is configured. */
  createBuildWatcher(
    functionsDir: string
  ): Promise<LocalRuntimeSpec | undefined>;
  /** Generate function types once, then watch for source changes. */
  startTypegen(input: {
    functionsDir: string;
    onRegenerate(filename: string): void;
    onError(error: Error): void;
  }): Promise<FunctionsTypegenSession>;
  /** Persist the VS Code attach configuration after the host is healthy. */
  ensureDebuggerConfig(input: {
    projectRoot: string;
    functionsDir: string;
    port: string;
    inspectPort: string;
    /**
     * Rewrite the port of an existing `Functions: Attach` entry when it differs
     * from `inspectPort`. Set only when this session starts an inspector.
     */
    syncPort?: boolean;
    signal?: CancellationToken;
  }): Promise<FunctionsDebuggerConfigResult>;
}

export interface LocalFunctionsRuntimeServiceOptions {
  /** Port probe seam; injected by tests to exercise bounded scanning. */
  isPortFree?: (port: number) => Promise<boolean>;
  /** Session-scoped ports already claimed by sibling local runtimes. */
  reservedPorts?: Set<number>;
  /** Health probe seam; injected by tests to avoid real HTTP polling. */
  waitForHostReady?: (
    port: string,
    signal?: CancellationToken
  ) => Promise<boolean>;
}

// Standard local origins intentionally cover Vite's 5173–5180 fallback ladder,
// Vite preview, Next.js, and their 127.0.0.1 aliases. Over-including these
// loopback origins is cheaper than a silent CORS failure after a dev server
// selects its next available port.
const STANDARD_LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  'http://localhost:5178',
  'http://localhost:5179',
  'http://localhost:5180',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
  'http://127.0.0.1:5176',
  'http://127.0.0.1:5177',
  'http://127.0.0.1:5178',
  'http://127.0.0.1:5179',
  'http://127.0.0.1:5180',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:8080',
] as const;

function canBindPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const server = createServer();
    const finish = (free: boolean): void => {
      server.removeAllListeners('error');
      server.removeAllListeners('listening');
      server.close(() => resolveProbe(free));
    };
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    try {
      server.listen(port, host);
    } catch {
      finish(false);
    }
  });
}

async function isPortFree(port: number): Promise<boolean> {
  // Windows can allow a loopback bind beside Core Tools' wildcard listener.
  return (
    (await canBindPort(port, '127.0.0.1')) &&
    (await canBindPort(port, '0.0.0.0'))
  );
}

async function findAvailablePort(
  startPort: number,
  windowSize: number,
  probePort: (port: number) => Promise<boolean>,
  reservedPorts?: Set<number>
): Promise<FunctionsPortSearchResult> {
  // The bounded window tolerates a few stale `func start` processes without
  // wandering far enough to claim unrelated Fabric development ports.
  let lastPort = startPort - 1;
  for (let offset = 0; offset < windowSize; offset += 1) {
    const candidate = startPort + offset;
    lastPort = candidate;
    if (!reservedPorts?.has(candidate) && (await probePort(candidate))) {
      reservedPorts?.add(candidate);
      return { port: candidate, searched: { from: startPort, to: candidate } };
    }
  }
  return { port: null, searched: { from: startPort, to: lastPort } };
}

async function upsertLocalSettings(
  functionsDir: string,
  values: Record<string, string>
): Promise<void> {
  const settingsPath = join(functionsDir, 'local.settings.json');
  let parsed: { IsEncrypted?: boolean; Values?: Record<string, string> } = {};
  try {
    parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }

  const settings = {
    IsEncrypted: parsed.IsEncrypted ?? false,
    Values: {
      FUNCTIONS_WORKER_RUNTIME: 'node',
      ...(parsed.Values ?? {}),
      ...values,
    },
  };
  if (!existsSync(functionsDir)) mkdirSync(functionsDir, { recursive: true });
  await writeFile(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8'
  );
}

function toOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function resolveCorsOrigins(config: RayfinConfig | null | undefined): string[] {
  const origins = new Set<string>();
  for (const value of config?.services?.auth?.allowedRedirectUris ?? []) {
    const origin = toOrigin(value);
    if (origin) origins.add(origin);
  }
  for (const origin of STANDARD_LOCAL_ORIGINS) origins.add(origin);
  return [...origins];
}

async function createBuildWatcher(
  functionsDir: string
): Promise<LocalRuntimeSpec | undefined> {
  const packagePath = join(functionsDir, 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as {
    scripts?: Record<string, unknown>;
  };
  const script = pkg.scripts?.['build:watch'];
  if (script === undefined) return undefined;
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error(
      `Invalid build:watch script in ${packagePath}. Add a long-running build:watch script for your compiler (for TypeScript, "tsc --build --watch"), then retry.`
    );
  }
  return {
    id: 'functions-build',
    label: 'functions compiler watcher (npm run build:watch)',
    command: 'npm',
    args: ['run', 'build:watch'],
    cwd: functionsDir,
    inheritStdio: true,
    required: true,
  };
}

/** Run the configured one-shot build before starting the functions host. */
export function runFunctionsBuild(input: {
  command: string;
  cwd: string;
  signal?: CancellationToken;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<void> {
  if (input.signal?.isCancellationRequested) {
    return Promise.reject(new Error('Functions build cancelled'));
  }
  return new Promise<void>((resolve, reject) => {
    // Keep the configured shell string intact, including chains and quoted paths.
    const child = spawn(input.command, {
      cwd: input.cwd,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    });
    const subscription = input.signal?.onCancellationRequested(() =>
      terminateProcessTree(child, 'SIGTERM', (message) =>
        input.onStderr?.(`${message}\n`)
      )
    );
    child.stdout?.on('data', (chunk: Buffer) =>
      input.onStdout?.(chunk.toString())
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      input.onStderr?.(chunk.toString())
    );
    child.on('close', (code, signal) => {
      subscription?.dispose();
      if (code === 0) resolve();
      else if (signal) reject(new Error(`build terminated by ${signal}`));
      else reject(new Error(`build failed with exit code ${code}`));
    });
    child.on('error', (error) => {
      subscription?.dispose();
      reject(error);
    });
  });
}

async function startTypegen(input: {
  functionsDir: string;
  onRegenerate(filename: string): void;
  onError(error: Error): void;
}): Promise<FunctionsTypegenSession> {
  // Imported lazily: the generator pulls in the TypeScript compiler, which is
  // far too heavy to load just to register the `dev` command tree.
  const { generateFunctionsTypes, watchAndGenerateTypes } =
    await import('../../utils/functions-types-generator.js');

  let initialError: Error | undefined;
  try {
    await generateFunctionsTypes(input.functionsDir);
  } catch (error) {
    initialError = error instanceof Error ? error : new Error(String(error));
  }

  const watcher = watchAndGenerateTypes(input.functionsDir, {
    onRegenerate: input.onRegenerate,
    onError: input.onError,
  });
  let closed = false;
  return {
    initialError,
    close(): void {
      if (closed) return;
      closed = true;
      watcher.close();
    },
  };
}

async function waitForHostReady(
  port: string,
  signal?: CancellationToken
): Promise<boolean> {
  const url = `http://localhost:${port}/admin/host/ping`;
  const deadline = Date.now() + 15_000;
  if (!(await delayUnlessCancelled(1_500, signal))) return false;
  while (Date.now() < deadline) {
    if (await probeHost(url, signal)) return true;
    if (!(await delayUnlessCancelled(750, signal))) return false;
  }
  return false;
}

async function probeHost(
  url: string,
  signal?: CancellationToken
): Promise<boolean> {
  if (signal?.isCancellationRequested === true) return false;
  const controller = new AbortController();
  const subscription = signal?.onCancellationRequested(() =>
    controller.abort()
  );
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    subscription?.dispose();
  }
}

function delayUnlessCancelled(
  milliseconds: number,
  signal?: CancellationToken
): Promise<boolean> {
  if (signal?.isCancellationRequested === true) return Promise.resolve(false);
  return new Promise<boolean>((resolveDelay) => {
    let settled = false;
    const cancellation: { subscription?: { dispose(): void } } = {};
    const timer = setTimeout(() => finish(true), milliseconds);
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancellation.subscription?.dispose();
      resolveDelay(completed);
    };
    cancellation.subscription = signal?.onCancellationRequested(() =>
      finish(false)
    );
    if (settled) cancellation.subscription?.dispose();
  });
}

/**
 * Merge the Functions attach entry into strict JSON.
 *
 * Missing files are created, existing entries are preserved, duplicate attach
 * entries are skipped, and JSONC is left untouched so comments are never lost.
 * With `syncPort`, an existing attach entry's port follows the inspector port
 * the session actually bound, since it slides forward when 9229 is busy.
 */
async function writeDebuggerConfig(input: {
  projectRoot: string;
  functionsDir: string;
  inspectPort: string;
  syncPort?: boolean;
}): Promise<FunctionsDebuggerConfigResult> {
  const vscodeDir = join(input.projectRoot, '.vscode');
  const launchPath = join(vscodeDir, 'launch.json');
  const relativeFunctionsPath = relative(input.projectRoot, input.functionsDir);
  const normalizedFunctionsPath = relativeFunctionsPath.split('\\').join('/');
  const workspaceFunctionsPath = normalizedFunctionsPath
    ? `\${workspaceFolder}/${normalizedFunctionsPath}`
    : '${workspaceFolder}';
  const newEntry = {
    type: 'node',
    request: 'attach',
    name: 'Functions: Attach',
    port:
      Number.parseInt(input.inspectPort, 10) ||
      Number(DEFAULT_FUNCTIONS_INSPECT_PORT),
    restart: true,
    skipFiles: ['<node_internals>/**'],
    sourceMaps: true,
    localRoot: workspaceFunctionsPath,
    remoteRoot: workspaceFunctionsPath,
  };

  let parsed: { version?: string; configurations?: unknown[] } | undefined;
  try {
    parsed = JSON.parse(await readFile(launchPath, 'utf8'));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      parsed = undefined;
    } else if (error instanceof SyntaxError) {
      // launch.json may be JSONC. Never strip comments or rewrite a file that
      // cannot be parsed as strict JSON.
      return { status: 'invalid-json', path: launchPath };
    } else {
      throw error;
    }
  }

  const configurations = Array.isArray(parsed?.configurations)
    ? [...parsed.configurations]
    : [];
  const isAttachEntry = (entry: unknown): entry is Record<string, unknown> =>
    entry !== null &&
    typeof entry === 'object' &&
    (entry as { name?: string }).name === 'Functions: Attach';
  if (configurations.some(isAttachEntry)) {
    const stale = configurations.some(
      (entry) => isAttachEntry(entry) && Number(entry.port) !== newEntry.port
    );
    if (!input.syncPort || !stale) {
      return { status: 'unchanged', path: launchPath };
    }
    const synced = configurations.map((entry) =>
      isAttachEntry(entry) ? { ...entry, port: newEntry.port } : entry
    );
    await writeFile(
      launchPath,
      `${JSON.stringify({ ...parsed, configurations: synced }, null, 2)}\n`,
      'utf8'
    );
    return { status: 'updated', path: launchPath, port: newEntry.port };
  }

  configurations.push(newEntry);
  const launchConfig = {
    // Preserve the compatibility command's existing merge shape in this pure
    // extraction. Fresh launch files never receive this legacy top-level key.
    ...(parsed ? { FUNCTIONS_WORKER_RUNTIME: 'node' } : {}),
    version: parsed?.version ?? '0.2.0',
    configurations,
  };
  if (!existsSync(vscodeDir)) mkdirSync(vscodeDir, { recursive: true });
  await writeFile(
    launchPath,
    `${JSON.stringify(launchConfig, null, 2)}\n`,
    'utf8'
  );
  return { status: 'written', path: launchPath };
}

export function createLocalFunctionsRuntimeService(
  options: LocalFunctionsRuntimeServiceOptions = {}
): LocalFunctionsRuntimeService {
  const probePort = options.isPortFree ?? isPortFree;
  const { reservedPorts } = options;
  const checkHostReady = options.waitForHostReady ?? waitForHostReady;
  return {
    findAvailablePort: (startPort, windowSize = FUNCTIONS_PORT_SCAN_WINDOW) =>
      findAvailablePort(startPort, windowSize, probePort, reservedPorts),
    upsertLocalSettings,
    resolveCorsOrigins,
    createBuildWatcher,
    startTypegen,
    async ensureDebuggerConfig(input): Promise<FunctionsDebuggerConfigResult> {
      // Do not litter the workspace with debugger config when `func start`
      // failed before becoming healthy.
      if (!(await checkHostReady(input.port, input.signal))) {
        return { status: 'not-ready' };
      }
      return writeDebuggerConfig(input);
    },
  };
}
