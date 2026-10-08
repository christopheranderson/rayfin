import { recordFabricResponseActivity } from '@microsoft/rayfin-cli/_internal/telemetry';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCreateInvocationContext,
  getCurrentContext,
  installCommanderHooks,
  markCurrentContextFailure,
  setCurrentContext,
} from '../telemetry/index.js';

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
    const ctx = new InvocationContext('create-rayfin', '1.0.0');
    setCurrentContext(ctx);
    expect(getCurrentContext()).toBe(ctx);
  });

  it('clears context when set to undefined', async () => {
    const { InvocationContext } =
      await import('@microsoft/rayfin-tools-common/_internal/telemetry');
    const ctx = new InvocationContext('create-rayfin', '1.0.0');
    setCurrentContext(ctx);
    setCurrentContext(undefined);
    expect(getCurrentContext()).toBeUndefined();
  });
});

// ── installCommanderHooks ───────────────────────────────────────────

describe('installCommanderHooks', () => {
  afterEach(() => {
    setCurrentContext(undefined);
  });

  it('registers preAction and postAction hooks on the program', () => {
    const program = new Command('create-rayfin');
    const hookSpy = vi.spyOn(program, 'hook');
    installCommanderHooks(program, '1.0.0');
    expect(hookSpy).toHaveBeenCalledWith('preAction', expect.any(Function));
    expect(hookSpy).toHaveBeenCalledWith('postAction', expect.any(Function));
  });
});

describe('createCreateInvocationContext', () => {
  it('uses the invocation id as the project origin dimension', () => {
    const context = createCreateInvocationContext('1.0.0', ['--template']);
    const event = context.finalize({
      osType: 'linux',
      osVersion: 'test',
      nodeVersion: 'test',
    });

    expect(event.properties?.project_origin_id).toBe(context.correlationId);
    expect(event.safeParameterNames).toEqual(['--template']);
  });

  it('adds a custom RAYFIN_TELEMETRY_ENV label to create telemetry', () => {
    const original = process.env['RAYFIN_TELEMETRY_ENV'];
    process.env['RAYFIN_TELEMETRY_ENV'] = 'Customer_Preview-01';

    try {
      const event = createCreateInvocationContext('1.0.0', []).finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      });
      expect(event.properties?.telemetry_environment).toBe(
        'customer_preview-01'
      );
    } finally {
      if (original === undefined) {
        delete process.env['RAYFIN_TELEMETRY_ENV'];
      } else {
        process.env['RAYFIN_TELEMETRY_ENV'] = original;
      }
    }
  });

  it('shares its context with CLI Fabric response enrichment', () => {
    const context = createCreateInvocationContext('1.0.0', []);
    setCurrentContext(context);

    recordFabricResponseActivity(
      new Response(null, {
        headers: { 'x-ms-root-activity-id': 'create-activity-1' },
      })
    );

    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["create-activity-1"]');
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
    const ctx = new InvocationContext('create-rayfin', '1.0.0');
    ctx.setCommand('create', []);
    setCurrentContext(ctx);

    markCurrentContextFailure(new Error('boom'));

    expect(getCurrentContext()).toBeUndefined();
    expect(ctx.hasResult).toBe(true);
  });

  it('does nothing when no context is set', () => {
    markCurrentContextFailure(new Error('no context'));
    expect(getCurrentContext()).toBeUndefined();
  });

  it('does nothing when context already has a result', async () => {
    const { InvocationContext } =
      await import('@microsoft/rayfin-tools-common/_internal/telemetry');
    const ctx = new InvocationContext('create-rayfin', '1.0.0');
    ctx.markSuccess();
    setCurrentContext(ctx);

    markCurrentContextFailure(new Error('too late'));

    // Context should still be set (markCurrentContextFailure skipped it).
    expect(getCurrentContext()).toBe(ctx);
  });
});
