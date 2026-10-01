/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { RayfinConfig } from '../types/config.js';
import { writeDeploymentEnvFile } from '../utils/env-fabric-utils.js';
import {
  persistHostingUrl,
  persistHostingUrlState,
} from '../utils/hosting-url-utils';

/**
 * Helper: write a minimal `rayfin/rayfin.yml` and return the project root.
 */
function makeProject(authEnabled: boolean): string {
  const dir = join(
    tmpdir(),
    `rayfin-hosting-url-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  );
  mkdirSync(join(dir, 'rayfin'), { recursive: true });

  const yml = `id: test-project
name: test-project
version: 1.0.0
services:
  auth:
    enabled: ${authEnabled ? 'true' : 'false'}
  data:
    enabled: true
    dialect: mssql
  storage:
    enabled: false
  staticHosting:
    enabled: true
    folder: dist
    buildCommand: npm run build
    indexDocument: index.html
`;
  writeFileSync(join(dir, 'rayfin', 'rayfin.yml'), yml);
  return dir;
}

function readYml(projectRoot: string): RayfinConfig {
  const raw = readFileSync(join(projectRoot, 'rayfin', 'rayfin.yml'), 'utf-8');
  return parse(raw) as RayfinConfig;
}

describe('persistHostingUrl', () => {
  let projectRoot: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (projectRoot) {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it('adds the bare origin to allowedRedirectUris when auth is disabled', async () => {
    projectRoot = makeProject(/* authEnabled */ false);

    const services: RayfinConfig['services'] = {
      auth: { enabled: false },
      data: { enabled: true, dialect: 'mssql' },
      storage: { enabled: false },
      staticHosting: { enabled: true, folder: 'dist' },
    } as RayfinConfig['services'];

    const postSettings = vi.fn().mockResolvedValue(undefined);

    await persistHostingUrl({
      hostingUrl: 'https://my-app.webapp.rayfingwdev.com',
      services,
      projectRoot,
      workspaceName: 'My Workspace',
      postSettings,
    });

    // Backend POST should have happened with the bare origin only.
    expect(postSettings).toHaveBeenCalledTimes(1);
    const posted = postSettings.mock.calls[0][0] as RayfinConfig['services'];
    expect(posted.auth?.allowedRedirectUris).toEqual([
      'https://my-app.webapp.rayfingwdev.com',
    ]);
    // The /auth/callback URI must NOT be added when auth is disabled.
    expect(posted.auth?.allowedRedirectUris).not.toContain(
      'https://my-app.webapp.rayfingwdev.com/auth/callback'
    );

    // rayfin.yml should have been updated with the bare origin.
    const updated = readYml(projectRoot);
    expect(updated.services.auth?.enabled).toBe(false);
    expect(updated.services.auth?.allowedRedirectUris).toEqual([
      'https://my-app.webapp.rayfingwdev.com',
    ]);
  });

  it('adds only the bare origin when auth is enabled', async () => {
    projectRoot = makeProject(/* authEnabled */ true);

    const services: RayfinConfig['services'] = {
      auth: { enabled: true },
      data: { enabled: true, dialect: 'mssql' },
      storage: { enabled: false },
      staticHosting: { enabled: true, folder: 'dist' },
    } as RayfinConfig['services'];

    const postSettings = vi.fn().mockResolvedValue(undefined);

    await persistHostingUrl({
      hostingUrl: 'https://my-app.webapp.rayfingwdev.com',
      services,
      projectRoot,
      workspaceName: 'My Workspace',
      postSettings,
    });

    expect(postSettings).toHaveBeenCalledTimes(1);
    const posted = postSettings.mock.calls[0][0] as RayfinConfig['services'];
    expect(posted.auth?.allowedRedirectUris).toEqual([
      'https://my-app.webapp.rayfingwdev.com',
    ]);
    // The /auth/callback URI must NOT be added by persistHostingUrl, even
    // when auth is enabled — callers are expected to manage callback URIs
    // themselves (e.g. via rayfin.yml).
    expect(posted.auth?.allowedRedirectUris).not.toContain(
      'https://my-app.webapp.rayfingwdev.com/auth/callback'
    );

    const updated = readYml(projectRoot);
    expect(updated.services.auth?.allowedRedirectUris).toEqual([
      'https://my-app.webapp.rayfingwdev.com',
    ]);
  });

  it('does not POST or rewrite rayfin.yml when the URI is already present', async () => {
    projectRoot = makeProject(/* authEnabled */ false);

    // Pre-populate with the origin we are about to "add".
    const services: RayfinConfig['services'] = {
      auth: {
        enabled: false,
        allowedRedirectUris: ['https://my-app.webapp.rayfingwdev.com'],
      },
      data: { enabled: true, dialect: 'mssql' },
      storage: { enabled: false },
      staticHosting: { enabled: true, folder: 'dist' },
    } as RayfinConfig['services'];

    const postSettings = vi.fn().mockResolvedValue(undefined);

    await persistHostingUrl({
      hostingUrl: 'https://my-app.webapp.rayfingwdev.com',
      services,
      projectRoot,
      workspaceName: 'My Workspace',
      postSettings,
    });

    expect(postSettings).not.toHaveBeenCalled();
  });

  it('returns persistence facts without rendering output', async () => {
    projectRoot = makeProject(/* authEnabled */ false);
    const services = {
      auth: { enabled: false },
      data: { enabled: true, dialect: 'mssql' },
    } as RayfinConfig['services'];
    const postSettings = vi.fn().mockResolvedValue(undefined);

    const result = await persistHostingUrlState({
      hostingUrl: 'https://my-app.webapp.rayfingwdev.com',
      services,
      projectRoot,
      workspaceName: 'My Workspace',
      postSettings,
    });

    expect(result).toMatchObject({
      configUpdated: true,
      redirectUriUpdated: true,
      warnings: [],
    });
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns a redirect warning instead of rendering it', async () => {
    projectRoot = makeProject(/* authEnabled */ false);
    const services = {
      auth: { enabled: false },
      data: { enabled: true, dialect: 'mssql' },
    } as RayfinConfig['services'];

    const result = await persistHostingUrlState({
      hostingUrl: 'https://my-app.webapp.rayfingwdev.com',
      services,
      projectRoot,
      workspaceName: 'My Workspace',
      postSettings: vi.fn().mockRejectedValue(new Error('patch failed')),
    });

    expect(result.warnings).toEqual([
      expect.stringContaining('Could not update redirect URIs: patch failed'),
    ]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns malformed-registry warnings without rendering them', async () => {
    projectRoot = makeProject(/* authEnabled */ false);
    writeFileSync(join(projectRoot, 'rayfin', '.deployments.json'), 'not json');

    const result = await persistHostingUrlState({
      hostingUrl: 'https://my-app.webapp.rayfingwdev.com',
      services: {
        auth: { enabled: false },
        data: { enabled: true, dialect: 'mssql' },
      } as RayfinConfig['services'],
      projectRoot,
      workspaceName: 'My Workspace',
    });

    expect(result.warnings).toEqual([
      expect.stringContaining('Could not parse'),
    ]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('preserves the legacy environment backup notice', async () => {
    projectRoot = makeProject(/* authEnabled */ false);
    await writeDeploymentEnvFile(projectRoot, 'My Workspace', {
      rayfinItemId: 'item-1',
      fabricWorkspaceId: 'workspace-1',
    });
    writeFileSync(
      join(projectRoot, 'rayfin', '.env'),
      '# hand-maintained\nCUSTOM_VALUE=preserved\n'
    );
    vi.mocked(console.warn).mockClear();

    await persistHostingUrl({
      hostingUrl: 'https://my-app.webapp.rayfingwdev.com',
      services: {
        auth: { enabled: false },
        data: { enabled: true, dialect: 'mssql' },
      } as RayfinConfig['services'],
      projectRoot,
      workspaceName: 'My Workspace',
    });

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Backed up your previous')
    );
  });
});
