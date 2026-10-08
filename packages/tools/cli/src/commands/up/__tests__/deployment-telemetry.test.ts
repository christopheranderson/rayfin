import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { noopDeploymentTelemetryCollector } from '@microsoft/rayfin-tools-common/_internal/services/project-telemetry';
import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import {
  runUpWorkflow,
  type UpDeps,
  type UpRequest,
} from '@microsoft/rayfin-tools-common/_internal/workflows/up';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliTelemetryHandle } from '../../../adapters/telemetry.js';
import { createCliProjectTelemetryService } from '../../../local-services/index.js';

const ORIGIN_ID = '9f970daa-6101-4df2-98f9-e0d86e975c61';

describe('up deployment telemetry integration', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-up-telemetry-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('joins the create origin with actual package versions before deployment failure', async () => {
    const projectTelemetry = createCliProjectTelemetryService();
    await projectTelemetry.persistProjectOrigin(projectRoot, ORIGIN_ID);
    writeJson(join(projectRoot, 'package.json'), {
      dependencies: {
        '@microsoft/rayfin-core': '^99.0.0',
        '@microsoft/fabric-visuals': 'latest',
        '@microsoft/rayfin-storage': 'workspace:*',
      },
    });
    writeInstalledPackage('@microsoft/rayfin-core', '1.35.0-alpha');
    writeInstalledPackage('@microsoft/fabric-visuals', '1.0.0');
    writeInstalledPackage('@microsoft/rayfin-storage', 'workspace:*');

    const context = new InvocationContext('rayfin-cli', '1.35.0-alpha');
    const deps = unusedDeps();
    deps.fabric.getWorkspace = vi
      .fn()
      .mockResolvedValue({ id: 'workspace', displayName: 'Workspace' });
    deps.fabric.getItemByName = vi
      .fn()
      .mockResolvedValue({ id: 'existing', displayName: 'app' });
    const result = await runUpWorkflow(
      { ...request(), projectRoot },
      {
        ...deps,
        projectTelemetry,
        telemetry: new CliTelemetryHandle(context),
      }
    );

    expect(result.status).toBe('failed');
    const event = context.finalize({
      osType: 'linux',
      osVersion: 'test',
      nodeVersion: 'test',
    });
    expect(event.properties).toEqual({
      project_origin_id: ORIGIN_ID,
      microsoft_packages:
        '[{"name":"@microsoft/fabric-visuals","version":"1.0.0"},{"name":"@microsoft/rayfin-core","version":"1.35.0-alpha"}]',
    });
    expect(event.measurements).toEqual({
      microsoft_package_count: 2,
      package_unresolved_count: 1,
    });
  });

  function writeInstalledPackage(name: string, version: string): void {
    const packageRoot = join(projectRoot, 'node_modules', ...name.split('/'));
    mkdirSync(packageRoot, { recursive: true });
    writeJson(join(packageRoot, 'package.json'), { name, version });
  }
});

function request(): UpRequest {
  return {
    config: {
      id: 'app',
      name: 'App',
      version: '1',
      services: {
        auth: { enabled: true },
        data: { enabled: false },
      },
    } as RayfinConfig,
    itemName: 'app',
    projectRoot: '',
    workspaceId: 'workspace',
    portalBaseUrl: 'https://portal.example',
  };
}

function unusedDeps(): UpDeps {
  const unexpected = (): never => {
    throw new Error('Cloud dependency should not be called');
  };
  return {
    diagnostics: { debug: vi.fn() },
    fabric: {
      findTrialCapacity: vi.fn(unexpected),
      listCapacities: vi.fn(unexpected),
      getCapacity: vi.fn(unexpected),
      checkTrialEligibility: vi.fn(unexpected),
      startTrial: vi.fn(unexpected),
      getOperationStatus: vi.fn(unexpected),
      getOperationResult: vi.fn(unexpected),
      listWorkspaces: vi.fn(unexpected),
      isWorkspaceAdmin: vi.fn(unexpected),
      getWorkspace: vi.fn(unexpected),
      createWorkspace: vi.fn(unexpected),
      assignWorkspaceToCapacity: vi.fn(unexpected),
      getItemByName: vi.fn(unexpected),
      createItem: vi.fn(unexpected),
    },
    workload: {
      resolveTarget: vi.fn(unexpected),
      getPublishableKey: vi.fn(unexpected),
      applyRuntimeSettings: vi.fn(unexpected),
    },
    connectors: { applyConfigs: vi.fn(unexpected) },
    data: { applyDatabaseConfig: vi.fn(unexpected) },
    storage: { applyStorageConfig: vi.fn(unexpected) },
    staticHosting: {
      validateFolder: vi.fn(unexpected),
      runBuild: vi.fn(unexpected),
      packageFolder: vi.fn(unexpected),
      deploy: vi.fn(unexpected),
      persistHostingUrl: vi.fn(unexpected),
      persistAssetAccess: vi.fn(unexpected),
    },
    authSdk: {
      inspect: vi.fn().mockResolvedValue({ state: 'satisfied' }),
      upgrade: vi.fn(unexpected),
    },
    packageInventory: {
      resolveDeployPackageVersions: vi.fn().mockResolvedValue({}),
    },
    runtimeConfig: {
      write: vi.fn(unexpected),
      remove: vi.fn(unexpected),
    },
    registry: {
      persistDeployment: vi.fn(unexpected),
      readDeployment: vi.fn(unexpected),
      getActiveDeployment: vi.fn(unexpected),
      listDeployments: vi.fn(unexpected),
      setActiveDeployment: vi.fn(unexpected),
    },
    frameworkEnv: {
      detectFramework: vi.fn(unexpected),
      writeEnvFile: vi.fn(unexpected),
    },
    functions: { deploy: vi.fn(unexpected) },
    devRedirect: {
      resolveFrontendDevPort: vi.fn(unexpected),
      appendLocalDevRedirectUris: vi.fn(unexpected),
    },
    projectTelemetry: noopDeploymentTelemetryCollector,
    telemetry: { addProperty: vi.fn(), addMeasurement: vi.fn() },
    progress: { report: vi.fn() },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
