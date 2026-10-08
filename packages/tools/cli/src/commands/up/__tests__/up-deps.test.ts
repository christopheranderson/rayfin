import {
  createLinkedCancellation,
  noopTelemetryHandle,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import { noopDeploymentTelemetryCollector } from '@microsoft/rayfin-tools-common/_internal/services/project-telemetry';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUpDeps } from '../up-deps.js';

interface FabricClientOptions {
  signal?: AbortSignal;
}

const mocks = vi.hoisted(() => ({
  createFabric: vi.fn(
    (_accessToken: string, _options: FabricClientOptions) => ({})
  ),
  createWorkload: vi.fn(() => ({})),
}));

vi.mock('../../../external-services/fabric/index.js', () => ({
  createCliFabricClient: mocks.createFabric,
  createCliRayfinWorkloadClient: mocks.createWorkload,
}));

vi.mock('../../../rayfin-services/index.js', () => ({
  createCliAuthSdkService: vi.fn(() => ({})),
  createCliConnectorService: vi.fn(() => ({})),
  createCliDataService: vi.fn(() => ({})),
  createCliDeploymentRegistryService: vi.fn(() => ({})),
  createCliDevRedirectService: vi.fn(() => ({})),
  createCliFrameworkEnvService: vi.fn(() => ({})),
  createCliFunctionsService: vi.fn(() => ({})),
  createCliPackageInventoryService: vi.fn(() => ({})),
  createCliRuntimeConfigService: vi.fn(() => ({})),
  createCliStaticHostingService: vi.fn(() => ({})),
  createCliStorageService: vi.fn(() => ({})),
}));

describe('createUpDeps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('propagates workflow cancellation to Fabric requests', () => {
    const cancellation = createLinkedCancellation();
    const deps = createUpDeps({
      accessToken: 'token',
      progress: { report: vi.fn() },
      diagnostics: { debug: vi.fn() },
      telemetry: noopTelemetryHandle,
      projectTelemetry: noopDeploymentTelemetryCollector,
      signal: cancellation.token,
    });

    const requestSignal = mocks.createFabric.mock.calls[0]?.[1]?.signal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(false);

    cancellation.cancel();

    expect(requestSignal?.aborted).toBe(true);
    deps.dispose();
  });

  it('stops observing cancellation after disposal', () => {
    const cancellation = createLinkedCancellation();
    const deps = createUpDeps({
      accessToken: 'token',
      progress: { report: vi.fn() },
      diagnostics: { debug: vi.fn() },
      telemetry: noopTelemetryHandle,
      projectTelemetry: noopDeploymentTelemetryCollector,
      signal: cancellation.token,
    });
    const requestSignal = mocks.createFabric.mock.calls[0]?.[1]?.signal;

    deps.dispose();
    cancellation.cancel();

    expect(requestSignal?.aborted).toBe(false);
  });
});
