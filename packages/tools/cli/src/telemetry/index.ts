/**
 * CLI telemetry orchestration.
 *
 * Initializes OpenTelemetry with the Azure Monitor exporter, provides
 * helpers to send telemetry events, and handles graceful shutdown with
 * flush-on-exit.
 *
 * Telemetry is best-effort. Initialization failures, send failures,
 * and shutdown failures are all silently ignored.
 */

import { platform, release } from 'os';
import { setTimeout as setTimeoutPromise } from 'timers/promises';

import type { Logger } from '@microsoft/rayfin-tools-common/_internal';
import {
  type EnvironmentInfo,
  type RayfinCommandEvent,
  extractSafeParamNames,
  InvocationContext,
  RAYFIN_APPINSIGHTS_CONNECTION_STRING,
  toOpenTelemetryAttributes,
} from '@microsoft/rayfin-tools-common/_internal/telemetry';
import type { Command } from 'commander';

import { getVersionString } from '../utils/version.js';

import { getCurrentContext, setCurrentContext } from './context-store.js';
import { getDevDeviceId } from './device-id.js';
import { addTelemetryEnvironment } from './enrichment.js';
import { showFirstRunNoticeIfNeeded } from './first-run-notice.js';
import { isRayfinToolTelemetryEnabled } from './policy.js';

/**
 * Application Insights connection string override.
 *
 * Falls back to the shared {@link RAYFIN_APPINSIGHTS_CONNECTION_STRING}
 * when no override is provided via the
 * `RAYFIN_APPINSIGHTS_CONNECTION_STRING` environment variable.
 */

// ── SDK state ───────────────────────────────────────────────────────

let shutdownFn: (() => Promise<void>) | undefined;
let logger: Logger | undefined;
let telemetryEnabled = false;
let devDeviceId: string | undefined;

// ── Tunables ────────────────────────────────────────────────────────
//
// The CLI emits at most one telemetry event per invocation, so we
// favor a synchronous-style export path with tight, CLI-friendly
// timeouts over the OTel SDK's batching defaults (which are tuned for
// long-running services and add up to ~5s of tail latency to short
// CLI invocations).

/**
 * Default ceiling for `shutdownTelemetry()` before we give up and let
 * the process exit. Best-effort: a single in-flight event may be lost
 * if the network is slower than this budget.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000;

/**
 * Default `exportTimeoutMillis` for the `BatchLogRecordProcessor`.
 * Keeps the worst-case flush bounded well below the shutdown budget so
 * that the timeout in {@link shutdownTelemetry} is rarely the thing
 * that trips first.
 */
const FORCE_FLUSH_TIMEOUT_MS = 1500;

/**
 * Resolve the shutdown budget. Allows tests and power users to
 * override the default via `RAYFIN_TELEMETRY_SHUTDOWN_TIMEOUT_MS`.
 * Non-positive or non-numeric values fall back to the default.
 *
 * @internal Visible for testing.
 */
export function getShutdownTimeoutMs(): number {
  const raw = process.env['RAYFIN_TELEMETRY_SHUTDOWN_TIMEOUT_MS'];
  if (!raw) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * Race a shutdown promise against a timeout. Resolves to `'done'` if
 * the shutdown completes within the budget, `'timeout'` otherwise.
 * Never rejects; shutdown errors are surfaced as `'done'` so callers
 * can treat them as best-effort.
 *
 * @internal Visible for testing.
 */
export async function awaitShutdownWithTimeout(
  shutdown: () => Promise<void>,
  timeoutMs: number
): Promise<'done' | 'timeout' | 'error'> {
  const timeoutController = new AbortController();
  const timeoutPromise = setTimeoutPromise(timeoutMs, 'timeout' as const, {
    signal: timeoutController.signal,
    ref: false,
  }).catch(() => 'timeout' as const);

  try {
    return await Promise.race([
      shutdown().then(
        () => 'done' as const,
        () => 'error' as const
      ),
      timeoutPromise,
    ]);
  } finally {
    timeoutController.abort();
  }
}

/**
 * Cached OTel LoggerProvider, loaded once during init.
 *
 * Typed loosely because the concrete type comes from a dynamic import;
 * the shape is verified at runtime.
 */

let otelLoggerProvider: any;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialize the telemetry subsystem.
 *
 * Must be called once before any events are recorded. If telemetry is
 * disabled by policy, this function is a no-op.
 */
export async function initTelemetry(log?: Logger): Promise<void> {
  logger = log;

  if (!isRayfinToolTelemetryEnabled()) {
    logger?.debug('Telemetry disabled by policy');
    return;
  }

  telemetryEnabled = true;
  showFirstRunNoticeIfNeeded();

  // Resolve the stable per-device identifier (best-effort). Cached for
  // the lifetime of the process; failures fall through with the field
  // left undefined.
  try {
    devDeviceId = await getDevDeviceId();
  } catch (error) {
    logger?.debug(`DevDeviceId resolution failed: ${String(error)}`);
  }

  const connectionString =
    process.env['RAYFIN_APPINSIGHTS_CONNECTION_STRING'] ??
    RAYFIN_APPINSIGHTS_CONNECTION_STRING;

  try {
    // Dynamic import to avoid loading OTel when telemetry is disabled.
    const { resources, logs } = await import('@opentelemetry/sdk-node');
    const { AzureMonitorLogExporter } =
      await import('@azure/monitor-opentelemetry-exporter');

    const logExporter = new AzureMonitorLogExporter({ connectionString });
    const loggerProvider = new logs.LoggerProvider({
      resource: resources.resourceFromAttributes({
        'service.name': 'rayfin-cli',
      }),
      // Use `BatchLogRecordProcessor` even though the CLI emits a
      // single event per invocation. `SimpleLogRecordProcessor` looks
      // attractive (no scheduled delay) but its `onEmit` fires the
      // export as `void doExport()` and neither `forceFlush` nor
      // `shutdown` await the in-flight Promise — so when the CLI
      // shuts down, the HTTP POST to Application Insights is dropped
      // mid-flight and events are lost.
      //
      // `BatchLogRecordProcessor.shutdown()` awaits `_flushAll()`,
      // which does await the export. The default 5000ms
      // `scheduledDelayMillis` only matters if `shutdown()` is never
      // called; we always call it, so it is not a tail-latency
      // concern here.
      processors: [
        new logs.BatchLogRecordProcessor({
          exporter: logExporter,
          // Bound the export so the shutdown flush can never exceed
          // the shutdown budget enforced in `shutdownTelemetry()`.
          // (`forceFlushTimeoutMillis` was removed from
          // `LoggerProviderOptions` in @opentelemetry/sdk-logs 0.222;
          // `exportTimeoutMillis` is the per-export bound the flush
          // awaits.)
          exportTimeoutMillis: FORCE_FLUSH_TIMEOUT_MS,
        }),
      ],
    });
    otelLoggerProvider = loggerProvider;

    shutdownFn = async () => {
      await loggerProvider.shutdown();
    };

    logger?.debug('Telemetry initialized with Application Insights');
  } catch (error) {
    logger?.debug(`Telemetry initialization failed: ${String(error)}`);
  }
}

/**
 * Send a finalized command event.
 *
 * Records the event as an OpenTelemetry log record. Per agreement
 * with the data-governance team, Rayfin CLI events land in the
 * `traces` table in Application Insights — so we deliberately do not
 * set the `microsoft.custom_event.name` attribute (which would route
 * the record to `customEvents`).
 */
export function sendCommandEvent(event: RayfinCommandEvent): void {
  if (!telemetryEnabled || !otelLoggerProvider) {
    return;
  }

  logger?.debug(
    `Telemetry event: ${event.commandName} → ${event.resultCategory} (${event.durationMs}ms)`
  );

  try {
    const otelLogger = otelLoggerProvider.getLogger(
      'rayfin-cli',
      event.productVersion
    );

    otelLogger.emit({
      timestamp: new Date(event.startTimeIso),
      // SeverityNumber is required by the Azure Monitor ingestion API.
      // Use INFO (9) for successful commands, WARN (13) for failures.
      severityNumber: event.resultCategory === 'Success' ? 9 : 13,
      attributes: toOpenTelemetryAttributes(event),
    });
  } catch {
    // Best-effort: silently ignore send failures.
  }
}

/**
 * Flush pending telemetry and shut down the SDK.
 *
 * Must be called before the process exits to ensure in-flight events
 * are delivered. Bounded by a configurable timeout
 * (`RAYFIN_TELEMETRY_SHUTDOWN_TIMEOUT_MS`, default
 * `DEFAULT_SHUTDOWN_TIMEOUT_MS`ms) so a slow network can never
 * hold the user at their shell prompt indefinitely. Best-effort: a
 * single in-flight event may be lost if shutdown exceeds the budget.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!shutdownFn) {
    return;
  }

  const timeoutMs = getShutdownTimeoutMs();
  const result = await awaitShutdownWithTimeout(shutdownFn, timeoutMs);
  switch (result) {
    case 'done':
      logger?.debug('Telemetry shutdown complete');
      break;
    case 'timeout':
      logger?.debug(
        `Telemetry shutdown timed out after ${timeoutMs}ms; continuing`
      );
      break;
    case 'error':
      logger?.debug('Telemetry shutdown failed');
      break;
  }
}

// ── Commander hooks ─────────────────────────────────────────────────

/**
 * Derive a dotted command name by walking Commander's parent chain.
 *
 * Examples: `dev` → `dev`, `dev db` → `dev.db`, `dev storage` → `dev.storage`.
 *
 * @internal Visible for testing.
 */
export function getFullCommandName(cmd: Command): string {
  const parts: string[] = [];
  let current: Command | null = cmd;
  while (current) {
    const name = current.name();
    // Stop at the root program (name is 'rayfin' or empty).
    if (!name || name === 'rayfin') {
      break;
    }
    parts.unshift(name);
    current = current.parent;
  }
  return parts.join('.');
}

/** Resolve the current platform environment info. */
function getEnvironmentInfo(): EnvironmentInfo {
  const shellEnv = process.env['SHELL'] || process.env['ComSpec'] || undefined;
  let shellType: string | undefined;
  if (shellEnv) {
    // Extract the shell name from the path (e.g. /bin/bash → bash).
    const parts = shellEnv.replace(/\\/g, '/').split('/');
    shellType = parts[parts.length - 1];
  }

  return {
    osType: platform(),
    osVersion: release(),
    nodeVersion: process.version,
    shellType,
    devDeviceId,
  };
}

/**
 * Install Commander pre-action and post-action hooks for automatic
 * telemetry instrumentation of all commands and subcommands.
 */
export function installCommanderHooks(program: Command): void {
  const version = getVersionString();

  program.hook('preAction', (_thisCommand: Command, actionCommand: Command) => {
    if (!telemetryEnabled) {
      return;
    }

    const ctx = new InvocationContext('rayfin-cli', version);
    const cmdName = getFullCommandName(actionCommand);
    const safeParams = extractSafeParamNames(process.argv.slice(2));
    ctx.setCommand(cmdName, safeParams);
    addTelemetryEnvironment(ctx);
    setCurrentContext(ctx);
  });

  program.hook('postAction', () => {
    const ctx = getCurrentContext();
    if (!ctx) {
      return;
    }

    if (!ctx.hasResult) {
      ctx.markSuccess();
    }

    const event = ctx.finalize(getEnvironmentInfo());
    sendCommandEvent(event);
    setCurrentContext(undefined);
  });
}

/**
 * Mark the current invocation as failed due to an unhandled error.
 *
 * Called from the top-level error handler in the CLI entry point.
 */
export function markCurrentContextFailure(error: Error): void {
  const ctx = getCurrentContext();
  if (ctx && !ctx.hasResult) {
    ctx.markFailure(error);
    const event = ctx.finalize(getEnvironmentInfo());
    sendCommandEvent(event);
    setCurrentContext(undefined);
  }
}

/**
 * Mark the current invocation as user-cancelled (e.g. declined an
 * overwrite prompt). Distinct from {@link markCurrentContextFailure}
 * because cancellation is its own telemetry category (`Canceled`),
 * not a failure — dashboards aggregate these differently.
 *
 * Called from the top-level error handler in the CLI entry point when
 * the dispatcher throws `ScaffoldCancelledError`. The function takes
 * no message argument: cancellation messages may be derived from user
 * input (URLs, paths) and forwarding them to telemetry's resultSummary
 * risks leaking tokens or PII. The `Canceled` category alone is the
 * signal — no free-text summary is sent.
 */
export function markCurrentContextCancelled(): void {
  const ctx = getCurrentContext();
  if (ctx && !ctx.hasResult) {
    ctx.markCanceled();
    const event = ctx.finalize(getEnvironmentInfo());
    sendCommandEvent(event);
    setCurrentContext(undefined);
  }
}
