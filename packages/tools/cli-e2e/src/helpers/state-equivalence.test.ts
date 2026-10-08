/**
 * Unit tests for state-equivalence helpers.
 *
 * These cover the small transformations (volatile field stripping, file
 * parsing) so future edits don't silently break the parity assertions
 * downstream tests rely on.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { createTempDir, useTrackedCleanup } from './run-cli.js';
import {
  captureProjectState,
  readDeploymentsRegistry,
  readRayfinYmlConfig,
  stripVolatileDeploymentFields,
} from './state-equivalence.js';

const { track: trackCleanup } = useTrackedCleanup();

function writeRayfinYml(projectDir: string, content: string): void {
  const rayfinDir = join(projectDir, 'rayfin');
  mkdirSync(rayfinDir, { recursive: true });
  writeFileSync(join(rayfinDir, 'rayfin.yml'), content);
}

function writeDeploymentsJson(projectDir: string, content: unknown): void {
  const rayfinDir = join(projectDir, 'rayfin');
  mkdirSync(rayfinDir, { recursive: true });
  writeFileSync(
    join(rayfinDir, '.deployments.json'),
    JSON.stringify(content, null, 2)
  );
}

describe('readRayfinYmlConfig', () => {
  it('parses rayfin.yml from a project directory', () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);
    writeRayfinYml(
      tmp.dir,
      `id: my-app
name: My App
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
`
    );

    const cfg = readRayfinYmlConfig(tmp.dir);
    expect(cfg).toEqual({
      id: 'my-app',
      name: 'My App',
      version: '1.0.0',
      services: {
        auth: { enabled: true },
        data: { enabled: false },
      },
    });
  });

  it('throws when rayfin.yml is missing', () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);
    expect(() => readRayfinYmlConfig(tmp.dir)).toThrow(/rayfin.yml not found/);
  });
});

describe('readDeploymentsRegistry', () => {
  it('parses .deployments.json from a project directory', () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);
    writeDeploymentsJson(tmp.dir, {
      active: 'my-workspace',
      deployments: {
        'my-workspace': {
          fabricItemId: 'item-1',
          deployedAt: '2026-06-04T00:00:00Z',
        },
      },
    });

    expect(readDeploymentsRegistry(tmp.dir)).toEqual({
      active: 'my-workspace',
      deployments: {
        'my-workspace': {
          fabricItemId: 'item-1',
          deployedAt: '2026-06-04T00:00:00Z',
        },
      },
    });
  });

  it('returns null when .deployments.json is absent', () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);
    expect(readDeploymentsRegistry(tmp.dir)).toBeNull();
  });
});

describe('stripVolatileDeploymentFields', () => {
  it('removes deployedAt from each deployment entry', () => {
    const input = {
      active: 'ws',
      deployments: {
        ws: {
          fabricItemId: 'item-1',
          fabricWorkspaceId: 'ws-1',
          deployedAt: '2026-06-04T00:00:00Z',
        },
      },
    };

    expect(stripVolatileDeploymentFields(input)).toEqual({
      active: 'ws',
      deployments: {
        ws: {
          fabricItemId: 'item-1',
          fabricWorkspaceId: 'ws-1',
        },
      },
    });
  });

  it('passes through null', () => {
    expect(stripVolatileDeploymentFields(null)).toBeNull();
  });

  it('passes through a registry with no deployments map', () => {
    const input = { active: 'ws' };
    expect(stripVolatileDeploymentFields(input)).toEqual({ active: 'ws' });
  });

  it('does not mutate the input', () => {
    const input = {
      deployments: {
        ws: { fabricItemId: 'x', deployedAt: '2026-06-04T00:00:00Z' },
      },
    };
    const copy = JSON.parse(JSON.stringify(input));
    stripVolatileDeploymentFields(input);
    expect(input).toEqual(copy);
  });
});

describe('captureProjectState', () => {
  it('returns yml and registry shapes equal across timestamp-only diffs', () => {
    const tmpA = createTempDir();
    const tmpB = createTempDir();
    trackCleanup(tmpA.cleanup);
    trackCleanup(tmpB.cleanup);

    const yml = `id: app
name: App
version: 1.0.0
services:
  auth:
    enabled: true
`;
    writeRayfinYml(tmpA.dir, yml);
    writeRayfinYml(tmpB.dir, yml);

    writeDeploymentsJson(tmpA.dir, {
      deployments: {
        ws: { fabricItemId: 'item-1', deployedAt: '2026-06-04T00:00:00Z' },
      },
    });
    writeDeploymentsJson(tmpB.dir, {
      deployments: {
        ws: { fabricItemId: 'item-1', deployedAt: '2026-06-04T11:11:11Z' },
      },
    });

    expect(captureProjectState(tmpA.dir)).toEqual(
      captureProjectState(tmpB.dir)
    );
  });
});
