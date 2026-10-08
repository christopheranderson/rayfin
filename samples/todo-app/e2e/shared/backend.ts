import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { fileURLToPath } from 'url';

import { resolveFrontendUrl, waitForFrontend } from './frontend';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_COMPOSE_OVERRIDE = 'docker-compose.override.yml';
const RESTART_NO_PULL_COMPOSE_OVERRIDE =
  'e2e/docker-compose.restart-no-pull.yml';

let backendProcess: ChildProcess | null = null;
let backendStarted = false;
/** Tracks whether this test run started the backend (vs. reusing an already-running one) */
let testStartedBackend = false;
/** Actual port detected from backend output */
let detectedPort: number | null = null;

export const E2E_BACKEND_PID_FILE_ENV_VAR = 'E2E_BACKEND_PID_FILE';

function isMissingProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(process.platform === 'win32' ? pid : -pid, signal);
}

function isProcessGroupRunning(pid: number): boolean {
  try {
    signalProcessGroup(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    throw error;
  }
}

async function terminateProcessGroup(pid: number): Promise<void> {
  try {
    signalProcessGroup(pid, 'SIGTERM');
  } catch (error) {
    if (isMissingProcessError(error)) return;
    throw error;
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    if (!isProcessGroupRunning(pid)) return;
    await sleep(100);
  }

  try {
    signalProcessGroup(pid, 'SIGKILL');
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
}

async function terminateBackendProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    child.kill('SIGTERM');
    await sleep(2000);
    if (!child.killed) {
      child.kill('SIGKILL');
    }
    return;
  }
  await terminateProcessGroup(pid);
}

function managedBackendPidFile(): string | undefined {
  return process.env[E2E_BACKEND_PID_FILE_ENV_VAR];
}

function readManagedBackendPid(): number | undefined {
  const pidFile = managedBackendPidFile();
  if (!pidFile) return undefined;

  let rawPid: string;
  try {
    rawPid = readFileSync(pidFile, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  const pid = Number(rawPid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(`Invalid E2E backend PID in ${pidFile}: ${rawPid}`);
  }
  return pid;
}

function removeManagedBackendPid(): void {
  const pidFile = managedBackendPidFile();
  if (pidFile) rmSync(pidFile, { force: true });
}

function recordManagedBackendPid(pid: number | undefined): void {
  const pidFile = managedBackendPidFile();
  if (pidFile && pid) writeFileSync(pidFile, `${pid}\n`);
}

async function terminateManagedBackendProcess(): Promise<void> {
  if (backendProcess) {
    await terminateBackendProcess(backendProcess);
    backendProcess = null;
    removeManagedBackendPid();
    return;
  }

  const managedPid = readManagedBackendPid();
  if (managedPid) {
    await terminateProcessGroup(managedPid);
    removeManagedBackendPid();
  }
}

/**
 * Log message emitted after backend settings and schema are applied, immediately
 * before the workflow starts the local frontend runtime.
 */
const READY_LOG_MESSAGE = 'Starting frontend dev server';

/**
 * Maximum time (ms) to wait for backend readiness.
 * Backend typically becomes ready within 60-90 seconds on first start.
 */
const BACKEND_READY_TIMEOUT_MS = 180_000; // 3 minutes

/** Default port for Rayfin backend */
const RAYFIN_DEFAULT_PORT = 5168;

const RAYFIN_API_URL = `http://localhost:${RAYFIN_DEFAULT_PORT}`;

/**
 * Regex patterns for detecting the backend port from CLI output.
 * The CLI outputs the port in various formats during startup.
 */
const PORT_DETECTION_PATTERNS = [
  /Web Service:\s*http:\/\/localhost:(\d+)/,
  /Applying configuration to Rayfin server:\s*http:\/\/localhost:(\d+)/,
];

interface BackendStartOptions {
  skipRunningCheck?: boolean;
  readyMessage?: string;
  reuseExistingImages?: boolean;
}

interface BackendStartInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Build the child-process invocation for an E2E backend start.
 *
 * Normal starts retain the contributor-facing `rayfin:dev:local` script. An
 * explicit image-reuse start invokes the equivalent CLI command directly so a
 * second Compose override can be appended with the platform path separator.
 */
export function buildBackendStartInvocation(
  options: Pick<BackendStartOptions, 'reuseExistingImages'> = {},
  env: NodeJS.ProcessEnv = process.env
): BackendStartInvocation {
  const { NODE_OPTIONS: _unused, ...cleanEnv } = env;
  const childEnv = {
    ...cleanEnv,
    CI: 'true',
  };

  if (!options.reuseExistingImages) {
    return {
      command: process.platform === 'win32' ? 'rushx.cmd' : 'rushx',
      args: ['rayfin:dev:local'],
      env: childEnv,
    };
  }

  return {
    command: process.platform === 'win32' ? 'rayfin.cmd' : 'rayfin',
    args: ['dev', '--provider', 'docker'],
    env: {
      ...childEnv,
      RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
      COMPOSE_FILE: [
        LOCAL_COMPOSE_OVERRIDE,
        RESTART_NO_PULL_COMPOSE_OVERRIDE,
      ].join(path.delimiter),
      COMPOSE_PROJECT_DIRECTORY: '../..',
    },
  };
}

/**
 * Try to detect and set the backend port from CLI output.
 * @param output - The CLI output string to parse
 * @returns true if a port was detected, false otherwise
 */
function tryDetectPort(output: string): boolean {
  if (detectedPort) return false; // Already detected

  for (const pattern of PORT_DETECTION_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      detectedPort = parseInt(match[1], 10);
      console.log(`🔍 Detected backend port: ${detectedPort}`);
      return true;
    }
  }
  return false;
}

/**
 * Get the base URL for the running Rayfin backend.
 * Uses the detected port from backend output if available, otherwise defaults to 5168.
 * @returns The base URL including the correct port
 */
export function getBackendUrl(): string {
  const port = detectedPort ?? RAYFIN_DEFAULT_PORT;
  return `http://localhost:${port}`;
}

/**
 * Get the detected port for the running Rayfin backend.
 * Returns the default port if backend hasn't started or port detection failed.
 */
export function getBackendPort(): number {
  return detectedPort ?? RAYFIN_DEFAULT_PORT;
}

/**
 * Check if a Rayfin backend is already running at the expected URL.
 * @returns true if backend responds to health check
 */
async function isBackendAlreadyRunning(): Promise<boolean> {
  try {
    const url = getBackendUrl();
    const response = await fetch(`${url}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });

    if (response.ok) {
      return true;
    }

    // Local Rayfin dev returns 401 when the backend is up but requires auth.
    // Treat client errors as an indicator that the service is reachable.
    if (response.status >= 400 && response.status < 500) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Ensure the backend is running (singleton pattern for shared backend)
 * In CI mode, assumes backend is already running (started by workflow)
 * In local mode, starts backend if not already running
 * @throws Error if backend fails to start within timeout
 */
export async function ensureBackendRunning(): Promise<void> {
  // In CI, the workflow starts the backend explicitly - skip auto-start
  if (process.env.CI === 'true') {
    console.log('📋 CI mode detected - assuming backend is already running');
    backendStarted = true;
    return;
  }

  if (backendStarted) {
    return;
  }
  await startBackend();
  backendStarted = true;
}

/**
 * Promise that resolves when the backend emits the ready log message.
 * Reset on each startBackend() call to support multiple start/stop cycles.
 */
let backendReadyPromise: Promise<void> | null = null;
let backendReadyResolve: (() => void) | null = null;

/**
 * Start the Rayfin backend using rayfin:dev:local
 * If backend is already running, reuses it without starting a new one.
 * Waits for runtime settings to be applied (not just health check)
 * @param options - Backend startup options:
 *   - `skipRunningCheck`: Skip the "already running" check and re-run the
 *     CLI startup flow. Useful when rayfin.yml has changed and settings need
 *     to be re-applied while containers are still up.
 *   - `readyMessage`: Custom log message to wait for instead of the default
 *     workflow runtime-start marker.
 *   - `reuseExistingImages`: Append the E2E-only no-pull Compose override.
 *     Use only after a successful start has cached every required image.
 * @throws Error if backend fails to start within timeout
 */
export async function startBackend(
  options: BackendStartOptions = {}
): Promise<void> {
  const {
    skipRunningCheck = false,
    readyMessage = READY_LOG_MESSAGE,
    reuseExistingImages = false,
  } = options;

  if (skipRunningCheck) {
    console.log(
      '🔄 Skipping already-running check, re-applying backend config...'
    );

    // If a prior backend process from an earlier startBackend() call is still
    // alive (e.g. the previous test timed out before its CLI finished applying
    // settings), tear it down before spawning a new one. Otherwise its stdout
    // listeners — which close over the *previous* readyMessage — would resolve
    // this call's readiness promise the moment the lingering CLI emits its
    // own ready log, causing us to query the backend while the stale CLI is
    // still mutating runtime settings.
    if (backendProcess) {
      const prior = backendProcess;
      prior.stdout?.removeAllListeners('data');
      prior.stderr?.removeAllListeners('data');
      prior.removeAllListeners('exit');
      prior.removeAllListeners('error');
      try {
        prior.kill();
      } catch {
        // Process may already be exiting; safe to ignore.
      }
    }

    // Reset state so the start logic runs fresh.
    backendProcess = null;
    backendStarted = false;
    testStartedBackend = false;
    detectedPort = null;
    backendReadyResolve = null;
    backendReadyPromise = null;
  }

  // Check if backend is already running externally
  if (!skipRunningCheck) {
    const alreadyRunning = await isBackendAlreadyRunning();
    if (alreadyRunning) {
      console.log(
        '✅ Rayfin backend is already running, reusing existing instance'
      );
      backendStarted = true;
      testStartedBackend = false;
      return;
    }
  }

  console.log('🚀 Starting Rayfin backend...');
  testStartedBackend = true;

  // Reset readiness promise for this start cycle
  backendReadyPromise = new Promise((resolve) => {
    backendReadyResolve = resolve;
  });

  // Spawn the normal local-dev script, or its E2E-only image-reuse equivalent.
  // On Windows, .cmd batch files require shell: true to execute (EINVAL without it).
  // Note: shell: true can break when the repo path contains spaces on Windows.
  // Ensure the repo is cloned to a path without spaces when running E2E tests locally on Windows.
  // Clear NODE_OPTIONS to prevent VS Code debugger flags from being inherited,
  // which would cause the child process to conflict on the debug port
  // Resolve to samples/todo-app directory (two levels up from e2e/shared/)
  const todoAppDir = path.resolve(__dirname, '../..');

  const invocation = buildBackendStartInvocation({ reuseExistingImages });
  backendProcess = spawn(invocation.command, invocation.args, {
    cwd: todoAppDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
    env: invocation.env,
  });
  recordManagedBackendPid(backendProcess.pid);
  const startedProcess = backendProcess;
  const readinessAbort = new AbortController();
  let rejectProcessFailure: ((reason: Error) => void) | undefined;
  const processFailure = new Promise<never>((_resolve, reject) => {
    rejectProcessFailure = reject;
  });

  const failReadiness = (error: Error): void => {
    readinessAbort.abort(error);
    rejectProcessFailure?.(error);
    rejectProcessFailure = undefined;
  };

  // Capture stdout and watch for ready signal
  startedProcess.stdout?.on('data', (data) => {
    const output = data.toString().trim();
    if (output) {
      console.log(`[Backend] ${output}`);

      // Try to detect the backend port from output
      tryDetectPort(output);

      // Check if backend is ready
      if (output.includes(readyMessage) && backendReadyResolve) {
        backendReadyResolve();
        backendReadyResolve = null; // Prevent duplicate resolution
      }
    }
  });

  startedProcess.stderr?.on('data', (data) => {
    const output = data.toString().trim();
    if (output) {
      // Docker Compose and many CLIs write all output to stderr (not just errors)
      // Only treat actual error patterns as errors
      const isError =
        output.toLowerCase().includes('error') ||
        output.toLowerCase().includes('fatal') ||
        output.toLowerCase().includes('failed');

      if (isError) {
        console.error(`[Backend Error] ${output}`);
      } else {
        console.log(`[Backend stderr] ${output}`);
      }

      // Try to detect the backend port from output
      tryDetectPort(output);

      // Check if backend is ready
      if (output.includes(readyMessage) && backendReadyResolve) {
        backendReadyResolve();
        backendReadyResolve = null; // Prevent duplicate resolution
      }
    }
  });

  startedProcess.on('error', (error) => {
    console.error('❌ Failed to start backend process:', error);
    failReadiness(new Error(`Backend process error: ${error.message}`));
  });

  startedProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`❌ Backend process exited with code ${code}`);
    }
    if (signal) {
      console.log(`⚠️ Backend process killed with signal ${signal}`);
    }
    failReadiness(
      new Error(
        code !== null
          ? `Backend dev process exited with code ${code}.`
          : `Backend dev process exited with signal ${signal ?? 'unknown'}.`
      )
    );
  });

  // Wait for backend to signal readiness via stdout logs
  console.log(
    '⏳ Waiting for backend to be ready (watching for runtime settings and database being configured)...'
  );
  await Promise.race([waitForBackendReady(), processFailure]);
  const frontendUrl = resolveFrontendUrl(todoAppDir);
  await Promise.race([
    waitForFrontend(frontendUrl, { signal: readinessAbort.signal }),
    processFailure,
  ]);
  rejectProcessFailure = undefined;

  // After the ready message, wait briefly for port detection from trailing CLI output.
  // The "Web Service: http://localhost:<port>" line often arrives after the ready signal.
  if (!detectedPort) {
    console.log('⏳ Waiting for port detection from backend output...');
    for (let i = 0; i < 10 && !detectedPort; i++) {
      await sleep(500);
    }
    if (!detectedPort) {
      console.warn(
        `⚠️ Port not detected from backend output, using default ${RAYFIN_DEFAULT_PORT}`
      );
    }
  }

  console.log(`✅ Rayfin backend is ready at ${getBackendUrl()}!`);
}

async function purgeBackend(options: {
  allowNonZeroExit: boolean;
}): Promise<void> {
  const { NODE_OPTIONS: _unusedPurge, ...cleanEnvPurge } = process.env;
  const todoAppDir = path.resolve(__dirname, '../..');
  const rayfinCmd = process.platform === 'win32' ? 'rayfin.cmd' : 'rayfin';
  const purgeProcess = spawn(rayfinCmd, ['--yes', 'dev', '--down', '--purge'], {
    cwd: todoAppDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...cleanEnvPurge,
      RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
      CI: 'true',
    },
  });

  await new Promise<void>((resolve, reject) => {
    purgeProcess.on('exit', (code) => {
      if (code === 0) {
        console.log('✅ Backend stopped and purged');
        resolve();
        return;
      }

      const message = `Purge exited with code ${code ?? 'unknown'}`;
      if (options.allowNonZeroExit) {
        console.warn(
          `⚠️ ${message} (containers may already be stopped or absent)`
        );
        resolve();
        return;
      }

      reject(new Error(message));
    });

    purgeProcess.on('error', (error) => {
      console.error('❌ Purge process error:', error);
      reject(error);
    });
  });
}

/**
 * Stop the Rayfin backend and optionally purge containers
 * Only stops if this test run started the backend (not if reusing external one).
 * Respects E2E_KEEP_BACKEND_RUNNING environment variable
 */
export async function stopBackend(): Promise<void> {
  const keepRunning = process.env.E2E_KEEP_BACKEND_RUNNING === 'true';

  if (keepRunning) {
    console.log('⏸️ Keeping backend running (E2E_KEEP_BACKEND_RUNNING=true)');
    return;
  }

  // Only tear down if we started it
  if (!testStartedBackend) {
    console.log(
      '⏸️ Backend was already running before test; leaving it running'
    );
    return;
  }

  console.log('🛑 Stopping Rayfin backend...');

  if (backendProcess) {
    await terminateManagedBackendProcess();
  }

  // Reset singleton state
  backendStarted = false;
  testStartedBackend = false;
  detectedPort = null;

  // Purge containers and volumes for clean slate
  console.log('🧹 Purging Rayfin containers and volumes...');
  await purgeBackend({ allowNonZeroExit: true });
}

/**
 * Force restart the backend by purging and starting fresh.
 * This is useful when the backend configuration needs to change (e.g., enabling email).
 * Ignores E2E_KEEP_BACKEND_RUNNING since we explicitly need a restart.
 *
 * @param startOptions - Options forwarded to {@link startBackend} for the
 *   fresh start when a caller needs a more specific workflow marker or can
 *   safely reuse the images cached by an earlier successful start.
 */
export async function forceRestartBackend(
  startOptions: Pick<
    BackendStartOptions,
    'readyMessage' | 'reuseExistingImages'
  > = {}
): Promise<void> {
  console.log('🔄 Force restarting backend with new configuration...');

  // Stop either the helper-owned process or the workflow-owned process group.
  await terminateManagedBackendProcess();

  // Reset state
  backendStarted = false;
  testStartedBackend = false;
  detectedPort = null;

  // Purge to clean up containers from any existing backend
  console.log('🧹 Purging existing backend containers...');
  await purgeBackend({ allowNonZeroExit: false });

  // Start fresh backend (CLI will allocate an available port)
  await startBackend(startOptions);
}

/**
 * Wait for backend readiness with timeout.
 * Relies on stdout log parsing rather than polling an endpoint.
 * @throws Error if backend doesn't emit ready message within timeout
 */
async function waitForBackendReady(): Promise<void> {
  if (!backendReadyPromise) {
    throw new Error(
      'Backend readiness promise not initialized. Call startBackend() first.'
    );
  }

  const startTime = Date.now();

  // Race between ready promise and timeout
  const timeoutPromise = sleep(BACKEND_READY_TIMEOUT_MS).then(() => {
    throw new Error(
      `Backend did not become ready within ${(BACKEND_READY_TIMEOUT_MS / 1000).toFixed(0)}s. ` +
        `Expected log message: "${READY_LOG_MESSAGE}"`
    );
  });

  await Promise.race([backendReadyPromise, timeoutPromise]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Backend ready in ${elapsed}s`);
}
