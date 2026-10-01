/**
 * Real-filesystem coverage for the posture write, which the mocked
 * `static-hosting.test.ts` cannot exercise: the value has to reach `rayfin.yml`
 * as a deep merge that leaves the rest of the project's configuration alone.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { createCliStaticHostingService } from '../static-hosting.js';

const BASE_YAML = `id: test-project
name: test-project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: false
  staticHosting:
    enabled: true
    folder: dist
`;

describe('createCliStaticHostingService().persistAssetAccess', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-posture-'));
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(join(projectRoot, 'rayfin', 'rayfin.yml'), BASE_YAML);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it.each([['protected'], ['public']] as const)(
    'persists %s to rayfin.yml',
    async (assetAccess) => {
      const result = await createCliStaticHostingService().persistAssetAccess({
        projectRoot,
        assetAccess,
      });

      expect(result).toEqual({ status: 'persisted' });
      expect(readYaml().services.staticHosting.assetAccess).toBe(assetAccess);
    }
  );

  it('never writes embedded.only', async () => {
    await createCliStaticHostingService().persistAssetAccess({
      projectRoot,
      assetAccess: 'protected',
    });

    expect(readYaml().services.staticHosting.embedded).toBeUndefined();
  });

  it('preserves unrelated configuration', async () => {
    await createCliStaticHostingService().persistAssetAccess({
      projectRoot,
      assetAccess: 'public',
    });

    const written = readYaml();
    expect(written.id).toBe('test-project');
    expect(written.services.auth.enabled).toBe(true);
    expect(written.services.staticHosting.enabled).toBe(true);
    expect(written.services.staticHosting.folder).toBe('dist');
  });

  it('removes legacy anonymousAccess while preserving other hosting fields', async () => {
    writeFileSync(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      `${BASE_YAML}    anonymousAccess: true\n    indexDocument: index.html\n`
    );

    await createCliStaticHostingService().persistAssetAccess({
      projectRoot,
      assetAccess: 'protected',
    });

    const written = readYaml();
    expect(written.services.staticHosting).toEqual({
      enabled: true,
      folder: 'dist',
      assetAccess: 'protected',
      indexDocument: 'index.html',
    });
  });

  it('reports failure when rayfin.yml is missing', async () => {
    rmSync(join(projectRoot, 'rayfin', 'rayfin.yml'));

    const result = await createCliStaticHostingService().persistAssetAccess({
      projectRoot,
      assetAccess: 'public',
    });

    expect(result.status).toBe('failed');
  });

  function readYaml(): any {
    return parse(
      readFileSync(join(projectRoot, 'rayfin', 'rayfin.yml'), 'utf-8')
    );
  }
});
