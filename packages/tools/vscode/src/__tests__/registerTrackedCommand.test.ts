/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';
import { registerTrackedCommand } from '../telemetry/registerTrackedCommand';
import type { TelemetryReporter } from '../telemetry/reporter';

// Provide a minimal ext.context for the telemetry helper.
beforeEach(() => {
  vi.clearAllMocks();

  ext.context = {
    subscriptions: [],
    extension: {
      packageJSON: { version: '0.0.1-test' },
    },
  } as unknown as vscode.ExtensionContext;

  ext.telemetryReporter = {
    sendCommandEvent: vi.fn(),
    sendActionEvent: vi.fn(),
    sendErrorEvent: vi.fn(),
    dispose: vi.fn(),
  } as unknown as TelemetryReporter;
});

describe('registerTrackedCommand', () => {
  it('emits a success event when the handler succeeds', async () => {
    const handler = vi.fn();
    registerTrackedCommand('test.command', handler);

    // The mock registerCommand captures the wrapper function
    const wrapper = (
      vscode.commands.registerCommand as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as (...args: unknown[]) => Promise<void>;
    await wrapper();

    expect(handler).toHaveBeenCalled();
    expect(ext.telemetryReporter!.sendCommandEvent).toHaveBeenCalledTimes(1);

    const event = (
      ext.telemetryReporter!.sendCommandEvent as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(event.commandName).toBe('test.command');
    expect(event.resultCategory).toBe('Success');
    expect(event.productName).toBe('rayfin-vscode');
    expect(typeof event.durationMs).toBe('number');
  });

  it('emits a failure event and re-throws when the handler throws', async () => {
    const error = new Error('test failure');
    const handler = vi.fn(() => {
      throw error;
    });
    registerTrackedCommand('test.failCommand', handler);

    const wrapper = (
      vscode.commands.registerCommand as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as (...args: unknown[]) => Promise<void>;
    await expect(wrapper()).rejects.toThrow('test failure');

    expect(ext.telemetryReporter!.sendCommandEvent).toHaveBeenCalledTimes(1);

    const event = (
      ext.telemetryReporter!.sendCommandEvent as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(event.commandName).toBe('test.failCommand');
    expect(event.resultCategory).toBe('Failure');
    expect(event.errorType).toBe('Error');
  });

  it('does not send telemetry when reporter is undefined', async () => {
    ext.telemetryReporter = undefined;
    const handler = vi.fn();
    registerTrackedCommand('test.noReporter', handler);

    const wrapper = (
      vscode.commands.registerCommand as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as (...args: unknown[]) => Promise<void>;
    await wrapper();

    // No error thrown — gracefully skipped
    expect(handler).toHaveBeenCalled();
  });
});
