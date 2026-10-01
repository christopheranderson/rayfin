/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ext } from '../extensionVariables';
import {
  DEFAULT_FABRIC_SETTINGS,
  getFabricSettings,
} from '../services/fabric/constants';

// ── Mock FabricApiClient to capture constructor args ────────────────

vi.mock('../extensionVariables', () => ({
  ext: {
    outputChannel: {
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    },
  },
}));

describe('FabricApiClient with FabricSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ext.outputChannel = {
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as unknown as typeof ext.outputChannel;
  });

  it('uses default settings when no fabricSettings provided', async () => {
    const { FabricApiClient } = await import('../services/fabric/client');
    const client = new FabricApiClient('test-token');
    // The client should use the daily default API base URL
    expect((client as unknown as { apiBaseUrl: string }).apiBaseUrl).toBe(
      DEFAULT_FABRIC_SETTINGS.fabricApiBaseUrl
    );
  });

  it('uses custom fabricSettings when provided', async () => {
    const { FabricApiClient } = await import('../services/fabric/client');
    const customSettings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: 'https://api.fabric.microsoft.com/v1',
    });
    const client = new FabricApiClient('test-token', false, customSettings);
    expect((client as unknown as { apiBaseUrl: string }).apiBaseUrl).toBe(
      'https://api.fabric.microsoft.com/v1'
    );
  });

  it('passes env-overridden settings through getFabricSettings', () => {
    const envFromDotfile: Record<string, string> = {
      RAYFIN_FABRIC_API_URL: 'https://dxtapi.fabric.microsoft.com/v1',
      RAYFIN_FABRIC_PORTAL_URL: 'https://dxt.fabric.microsoft.com/',
    };
    const settings = getFabricSettings(envFromDotfile);
    expect(settings.fabricApiBaseUrl).toBe(
      'https://dxtapi.fabric.microsoft.com/v1'
    );
    expect(settings.fabricPortalUrl).toBe('https://dxt.fabric.microsoft.com/');
    // Non-overridable settings remain default
    expect(settings.workloadId).toBe('BaaS');
    expect(settings.itemType).toBe('AppBackend');
  });
});

describe('RayfinItemClient with FabricSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ext.outputChannel = {
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as unknown as typeof ext.outputChannel;
  });

  it('uses default itemType when no fabricSettings provided', async () => {
    const { RayfinItemClient } = await import('../services/fabric/rayfinItem');
    const client = new RayfinItemClient('test-token');
    expect((client as unknown as { itemType: string }).itemType).toBe(
      'AppBackend'
    );
  });

  it('uses custom itemType from fabricSettings', async () => {
    const { RayfinItemClient } = await import('../services/fabric/rayfinItem');
    const customSettings = {
      ...DEFAULT_FABRIC_SETTINGS,
      itemType: 'CustomType',
    };
    const client = new RayfinItemClient('test-token', false, customSettings);
    expect((client as unknown as { itemType: string }).itemType).toBe(
      'CustomType'
    );
  });
});

describe('getFabricSettings integration with env Map', () => {
  it('works with Object.fromEntries of a Map (VS Code env loading pattern)', () => {
    const envMap = new Map<string, string>([
      ['RAYFIN_FABRIC_API_URL', 'https://msitapi.fabric.microsoft.com/v1'],
      ['RAYFIN_FABRIC_PORTAL_URL', 'https://msit.fabric.microsoft.com/'],
      ['OTHER_VAR', 'some-value'],
    ]);
    const settings = getFabricSettings(Object.fromEntries(envMap));
    expect(settings.fabricApiBaseUrl).toBe(
      'https://msitapi.fabric.microsoft.com/v1'
    );
    expect(settings.fabricPortalUrl).toBe('https://msit.fabric.microsoft.com/');
  });

  it('returns all defaults when env Map has no Fabric overrides', () => {
    const envMap = new Map<string, string>([
      ['DB_CONNECTION', 'some-connection-string'],
    ]);
    const settings = getFabricSettings(Object.fromEntries(envMap));
    expect(settings.fabricApiBaseUrl).toBe(
      DEFAULT_FABRIC_SETTINGS.fabricApiBaseUrl
    );
    expect(settings.fabricPortalUrl).toBe(
      DEFAULT_FABRIC_SETTINGS.fabricPortalUrl
    );
  });
});
