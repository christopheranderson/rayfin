import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentContext, setCurrentContext } from '../context-store.js';
import {
  awaitShutdownWithTimeout,
  getFullCommandName,
  getShutdownTimeoutMs,
  installCommanderHooks,
  markCurrentContextCancelled,
  markCurrentContextFailure,
} from '../index.js';
import { isRayfinToolTelemetryEnabled } from '../policy.js';

// ── Telemetry policy ────────────────────────────────────────────────

describe('isRayfinToolTelemetryEnabled', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all relevant env vars.
    delete process.env['RAYFIN_TELEMETRY_OPTOUT'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns true by default (opt-out model)', () => {
    expect(isRayfinToolTelemetryEnabled()).toBe(true);
  });

  it('returns false when RAYFIN_TELEMETRY_OPTOUT=1', () => {
    process.env['RAYFIN_TELEMETRY_OPTOUT'] = '1';
    expect(isRayfinToolTelemetryEnabled()).toBe(false);
  });

  it('returns true in CI environments (CI can opt out via RAYFIN_TELEMETRY_OPTOUT)', () => {
    process.env['CI'] = 'true';
    expect(isRayfinToolTelemetryEnabled()).toBe(true);
  });
});

// ── initTelemetry device identifier ─────────────────────────────────

describe('initTelemetry device identifier resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['RAYFIN_TELEMETRY_OPTOUT'];
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /**
   * Load a fresh telemetry module with the device-id and first-run-notice
   * side effects stubbed. The exporter import is forced to fail so init
   * never builds a real OTel provider.
   */
  async function loadTelemetry(getDevDeviceId: () => Promise<string>) {
    vi.doMock('../device-id.js', () => ({ getDevDeviceId }));
    vi.doMock('../first-run-notice.js', () => ({
      showFirstRunNoticeIfNeeded: vi.fn(),
    }));
    vi.doMock('@azure/monitor-opentelemetry-exporter', () => {
      throw new Error('exporter unavailable under test');
    });
    return import('../index.js');
  }

  it('performs no identifier I/O when telemetry is opted out', async () => {
    process.env['RAYFIN_TELEMETRY_OPTOUT'] = '1';
    const getDevDeviceId = vi.fn().mockResolvedValue('unused');
    const telemetry = await loadTelemetry(getDevDeviceId);

    await telemetry.initTelemetry();

    expect(getDevDeviceId).not.toHaveBeenCalled();
  });

  it('keeps telemetry best-effort when identifier persistence fails', async () => {
    const getDevDeviceId = vi
      .fn()
      .mockRejectedValue(new Error('EACCES: permission denied'));
    const telemetry = await loadTelemetry(getDevDeviceId);

    await expect(telemetry.initTelemetry()).resolves.toBeUndefined();
    expect(getDevDeviceId).toHaveBeenCalledOnce();
  });
});

// ── Context store ───────────────────────────────────────────────────

describe('context store', () => {
  afterEach(() => {
    setCurrentContext(undefined);
  });

  it('starts with no context', () => {
    expect(getCurrentContext()).toBeUndefined();
  });

  it('round-trips a context', async () => {
    const { InvocationContext } =
      await import('@microsoft/rayfin-tools-common/_internal/telemetry');
    const ctx = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(ctx);
    expect(getCurrentContext()).toBe(ctx);
  });

  it('clears context when set to undefined', async () => {
    const { InvocationContext } =
      await import('@microsoft/rayfin-tools-common/_internal/telemetry');
    const ctx = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(ctx);
    setCurrentContext(undefined);
    expect(getCurrentContext()).toBeUndefined();
  });
});

// ── getFullCommandName ──────────────────────────────────────────────

describe('getFullCommandName', () => {
  it('returns single command name', () => {
    const program = new Command('rayfin');
    const sub = new Command('init');
    program.addCommand(sub);
    expect(getFullCommandName(sub)).toBe('init');
  });

  it('returns dotted name for nested subcommands', () => {
    const program = new Command('rayfin');
    const dev = new Command('dev');
    const db = new Command('db');
    program.addCommand(dev);
    dev.addCommand(db);
    expect(getFullCommandName(db)).toBe('dev.db');
  });

  it('returns empty string for root program', () => {
    const program = new Command('rayfin');
    expect(getFullCommandName(program)).toBe('');
  });

  it('stops at root even with deeply nested commands', () => {
    const program = new Command('rayfin');
    const a = new Command('a');
    const b = new Command('b');
    const c = new Command('c');
    program.addCommand(a);
    a.addCommand(b);
    b.addCommand(c);
    expect(getFullCommandName(c)).toBe('a.b.c');
  });
});

// ── installCommanderHooks ───────────────────────────────────────────

describe('installCommanderHooks', () => {
  afterEach(() => {
    setCurrentContext(undefined);
  });

  it('registers preAction and postAction hooks on the program', () => {
    const program = new Command('rayfin');
    const hookSpy = vi.spyOn(program, 'hook');
    installCommanderHooks(program);
    expect(hookSpy).toHaveBeenCalledWith('preAction', expect.any(Function));
    expect(hookSpy).toHaveBeenCalledWith('postAction', expect.any(Function));
  });
});

// ── markCurrentContextFailure ───────────────────────────────────────

describe('markCurrentContextFailure', () => {
  afterEach(() => {
    setCurrentContext(undefined);
  });

  it('marks context as failed and clears it', async () => {
    const { InvocationContext } =
      await import('@microsoft/rayfin-tools-common/_internal/telemetry');
    const ctx = new InvocationContext('rayfin-cli', '1.0.0');
    ctx.setCommand('test', []);
    setCurrentContext(ctx);

    markCurrentContextFailure(new Error('boom'));

    expect(getCurrentContext()).toBeUndefined();
    expect(ctx.hasResult).toBe(true);
  });

  it('does nothing when no context is set', () => {
    // Should not throw.
    markCurrentContextFailure(new Error('no context'));
    expect(getCurrentContext()).toBeUndefined();
  });

  it('does nothing when context already has a result', async () => {
    const { InvocationContext } =
      await import('@microsoft/rayfin-tools-common/_internal/telemetry');
    const ctx = new InvocationContext('rayfin-cli', '1.0.0');
    ctx.markSuccess();
    setCurrentContext(ctx);

    markCurrentContextFailure(new Error('too late'));

    // Context should still be set (markCurrentContextFailure skipped it).
    expect(getCurrentContext()).toBe(ctx);
  });
});

// ── markCurrentContextCancelled ─────────────────────────────────────

describe('markCurrentContextCancelled', () => {
  afterEach(() => {
    setCurrentContext(undefined);
  });

  it('marks context as user-cancelled (Canceled category) and clears it', async () => {
    const { InvocationContext } =
      await import('@microsoft/rayfin-tools-common/_internal/telemetry');
    const ctx = new InvocationContext('rayfin-cli', '1.0.0');
    ctx.setCommand('init', []);
    setCurrentContext(ctx);

    markCurrentContextCancelled();

    expect(getCurrentContext()).toBeUndefined();
    expect(ctx.hasResult).toBe(true);
    // Critically: cancellation gets its own telemetry category. The
    // emitted event must report `Canceled` so dashboards can distinguish
    // user-decline from operation crashes (`Failure`) and from successful
    // runs (`Success`). Conflating them would make the new exit-code-2
    // contract unobservable in telemetry.
    const env = {
      osType: 'Linux',
      osVersion: '1',
      nodeVersion: '24',
    };
    const event = ctx.finalize(env);
    expect(event.resultCategory).toBe('Canceled');
    // Privacy: no resultSummary (we deliberately don't accept a message
    // because cancellation messages may include user-provided URLs/paths).
    expect(event.resultSummary).toBeUndefined();
  });

  it('does nothing when no context is set', () => {
    // Should not throw.
    markCurrentContextCancelled();
    expect(getCurrentContext()).toBeUndefined();
  });

  it('does nothing when context already has a result', async () => {
    const { InvocationContext } =
      await import('@microsoft/rayfin-tools-common/_internal/telemetry');
    const ctx = new InvocationContext('rayfin-cli', '1.0.0');
    ctx.markSuccess();
    setCurrentContext(ctx);

    markCurrentContextCancelled();

    // Context should still be set (markCurrentContextCancelled skipped it).
    expect(getCurrentContext()).toBe(ctx);
  });
});

// ── getShutdownTimeoutMs ────────────────────────────────────────────

describe('getShutdownTimeoutMs', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['RAYFIN_TELEMETRY_SHUTDOWN_TIMEOUT_MS'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns the default when the env var is unset', () => {
    expect(getShutdownTimeoutMs()).toBe(2000);
  });

  it('honors a positive numeric override', () => {
    process.env['RAYFIN_TELEMETRY_SHUTDOWN_TIMEOUT_MS'] = '500';
    expect(getShutdownTimeoutMs()).toBe(500);
  });

  it('falls back to the default for non-numeric values', () => {
    process.env['RAYFIN_TELEMETRY_SHUTDOWN_TIMEOUT_MS'] = 'soon';
    expect(getShutdownTimeoutMs()).toBe(2000);
  });

  it('falls back to the default for zero or negative values', () => {
    process.env['RAYFIN_TELEMETRY_SHUTDOWN_TIMEOUT_MS'] = '0';
    expect(getShutdownTimeoutMs()).toBe(2000);
    process.env['RAYFIN_TELEMETRY_SHUTDOWN_TIMEOUT_MS'] = '-100';
    expect(getShutdownTimeoutMs()).toBe(2000);
  });
});

// ── awaitShutdownWithTimeout ────────────────────────────────────────

describe('awaitShutdownWithTimeout', () => {
  it('resolves to "done" when shutdown completes within the budget', async () => {
    const result = await awaitShutdownWithTimeout(
      () => Promise.resolve(),
      1000
    );
    expect(result).toBe('done');
  });

  it('resolves to "timeout" when shutdown exceeds the budget', async () => {
    const start = Date.now();
    const result = await awaitShutdownWithTimeout(
      () => new Promise<void>(() => undefined),
      25
    );
    expect(result).toBe('timeout');
    // Sanity-check the timeout is observed quickly, well under any
    // realistic OTel default (5000ms+).
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('resolves to "error" when shutdown rejects', async () => {
    const result = await awaitShutdownWithTimeout(
      () => Promise.reject(new Error('boom')),
      1000
    );
    expect(result).toBe('error');
  });
});
