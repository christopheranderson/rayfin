/**
 * Telemetry orchestration for create-rayfin.
 *
 * Mirrors the CLI telemetry pattern: initializes OpenTelemetry with
 * the Azure Monitor exporter, provides helpers to send telemetry
 * events, and handles graceful shutdown with flush-on-exit.
 *
 * Telemetry is best-effort. Initialization failures, send failures,
 * and shutdown failures are all silently ignored.
 */

import { platform, release } from 'os';

import {
  addTelemetryEnvironment,
  getCurrentContext,
  getDevDeviceId,
  isRayfinToolTelemetryEnabled,
  setCurrentContext,
  showFirstRunNoticeIfNeeded,
} from '@microsoft/rayfin-cli/_internal/telemetry';
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

// Future improvement: replace this with a type-only OpenTelemetry provider
// shape once the dynamic import path can preserve strong typing cleanly.

/**
 * Cached OTel LoggerProvider, loaded once during init.
 *
 * Typed loosely because the concrete type comes from a dynamic import;
 * the shape is verified at runtime.
 */
let otelLoggerProvider: any;

// Re-export context store for external consumers (tests, entry point).
export {
  getCurrentContext,
  setCurrentContext,
} from '@microsoft/rayfin-cli/_internal/telemetry';

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
        'service.name': 'create-rayfin',
      }),
      processors: [new logs.BatchLogRecordProcessor({ exporter: logExporter })],
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
 * with the data-governance team, create-rayfin events land in the
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
      'create-rayfin',
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
 * are delivered.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (shutdownFn) {
    try {
      await shutdownFn();
      logger?.debug('Telemetry shutdown complete');
    } catch (error) {
      logger?.debug(`Telemetry shutdown failed: ${error}`);
    }
  }
}

// ── Commander hooks ─────────────────────────────────────────────────

/** Resolve the current platform environment info. */
function getEnvironmentInfo(): EnvironmentInfo {
  const shellEnv = process.env['SHELL'] || process.env['ComSpec'] || undefined;
  let shellType: string | undefined;
  if (shellEnv) {
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
 * telemetry instrumentation.
 */
export function installCommanderHooks(program: Command, version: string): void {
  program.hook('preAction', () => {
    if (!telemetryEnabled) {
      return;
    }

    setCurrentContext(
      createCreateInvocationContext(version, process.argv.slice(2))
    );
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

/** Build the invocation context shared by create telemetry and provenance. */
export function createCreateInvocationContext(
  version: string,
  args: string[]
): InvocationContext {
  const ctx = new InvocationContext('create-rayfin', version);
  ctx.setCommand('create', extractSafeParamNames(args));
  ctx.addProperty('project_origin_id', ctx.correlationId);
  addTelemetryEnvironment(ctx);
  return ctx;
}

/**
 * Mark the current invocation as failed due to an unhandled error.
 *
 * Called from the top-level error handler in the entry point.
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
 * Mirrors the API of `markCurrentContextCancelled` in
 * `@microsoft/rayfin-cli/_internal/telemetry`. Both wrappers expose the
 * same name so wrapper code (this package's `src/index.ts` and
 * `@microsoft/rayfin-cli`'s `scripts/main`) can call the same symbol.
 * Each wrapper has its own implementation because each emits to its
 * own OTel tracer (`'create-rayfin'` vs `'rayfin-cli'`).
 *
 * No message argument: cancellation messages may be derived from user
 * input (URLs, paths) and forwarding them to telemetry's `resultSummary`
 * risks leaking tokens or PII. The `Canceled` category alone is the
 * signal — no free-text summary is sent.
 */
export function markCurrentContextCancelled(): void {
  finalizeCurrentContext('cancelled');
}

/**
 * Finalize the current invocation context for a controlled scaffold
 * exit (see `ScaffoldExit` in the entry point).
 *
 * Commander's `postAction` hook does not run when the action callback
 * throws, so we emit the command event manually from the top-level
 * catch block before the process exits.
 *
 * `'cancelled'` records the dedicated `Canceled` telemetry category
 * (distinct from both `Success` and `UserFault`); the optional
 * `message` is ignored on this path because cancellation messages can
 * be derived from user input (URLs/paths) and shouldn't flow into
 * telemetry's `resultSummary`.
 */
export function finalizeCurrentContext(
  outcome: 'success' | 'userFault' | 'cancelled',
  message?: string
): void {
  const ctx = getCurrentContext();
  if (!ctx || ctx.hasResult) {
    return;
  }
  if (outcome === 'success') {
    ctx.markSuccess();
  } else if (outcome === 'cancelled') {
    ctx.markCanceled();
  } else {
    ctx.markUserFault(message ?? 'User-facing scaffold error');
  }
  const event = ctx.finalize(getEnvironmentInfo());
  sendCommandEvent(event);
  setCurrentContext(undefined);
}
