import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliProjectTelemetryService } from '../project-telemetry.js';

const ORIGIN_ID = '9f970daa-6101-4df2-98f9-e0d86e975c61';

describe('createCliProjectTelemetryService', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-project-telemetry-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('atomically persists and reads project provenance', async () => {
    const service = createCliProjectTelemetryService();

    await service.persistProjectOrigin(projectRoot, ORIGIN_ID);

    expect(
      JSON.parse(
        readFileSync(join(projectRoot, 'rayfin', '.project.json'), 'utf8')
      )
    ).toEqual({
      _comment:
        'Created by create-rayfin to correlate anonymous scaffold and deployment telemetry. Commit this file with your project.',
      version: 1,
      projectOriginId: ORIGIN_ID,
    });
    await expect(
      service.collectDeploymentTelemetry(projectRoot, [])
    ).resolves.toMatchObject({ projectOriginId: ORIGIN_ID });
  });

  it('does not persist an invalid origin id', async () => {
    const service = createCliProjectTelemetryService();

    await service.persistProjectOrigin(projectRoot, 'not-a-uuid');

    expect(existsSync(join(projectRoot, 'rayfin', '.project.json'))).toBe(
      false
    );
  });

  it.skipIf(process.platform === 'win32')(
    'does not write provenance through a rayfin symlink outside the project',
    async () => {
      const outsideRoot = mkdtempSync(
        join(tmpdir(), 'rayfin-outside-metadata-')
      );
      try {
        symlinkSync(outsideRoot, join(projectRoot, 'rayfin'), 'dir');

        await createCliProjectTelemetryService().persistProjectOrigin(
          projectRoot,
          ORIGIN_ID
        );

        expect(existsSync(join(outsideRoot, '.project.json'))).toBe(false);
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'does not read provenance through a rayfin symlink outside the project',
    async () => {
      writeProjectManifest({});
      const outsideRoot = mkdtempSync(
        join(tmpdir(), 'rayfin-outside-metadata-')
      );
      try {
        writeJson(join(outsideRoot, '.project.json'), {
          version: 1,
          projectOriginId: ORIGIN_ID,
        });
        symlinkSync(outsideRoot, join(projectRoot, 'rayfin'), 'dir');

        const result =
          await createCliProjectTelemetryService().collectDeploymentTelemetry(
            projectRoot,
            []
          );

        expect(result.projectOriginId).toBeUndefined();
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }
    }
  );

  it('ignores malformed provenance while still collecting packages', async () => {
    writeProjectManifest({
      dependencies: { '@microsoft/rayfin-core': '^99.0.0' },
    });
    writeInstalledPackage(
      projectRoot,
      '@microsoft/rayfin-core',
      '1.35.0-alpha'
    );
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(join(projectRoot, 'rayfin', '.project.json'), 'not json');

    await expect(
      createCliProjectTelemetryService().collectDeploymentTelemetry(
        projectRoot,
        []
      )
    ).resolves.toEqual({
      projectOriginId: undefined,
      microsoftPackages: [
        { name: '@microsoft/rayfin-core', version: '1.35.0-alpha' },
      ],
      unresolvedPackageCount: 0,
    });
  });

  it('collects actual installed versions from deployment package roots', async () => {
    writeProjectManifest({
      dependencies: {
        '@microsoft/rayfin-core': '^99.0.0',
        'not-microsoft': '1.0.0',
        '@microsoft/internal-codename': '1.0.0',
      },
      devDependencies: { '@microsoft/rayfin-lib': 'workspace:*' },
    });
    writeInstalledPackage(
      projectRoot,
      '@microsoft/rayfin-core',
      '1.35.0-alpha'
    );
    writeInstalledPackage(projectRoot, '@microsoft/rayfin-lib', '1.0.0');

    const serviceRoot = join(projectRoot, 'packages', 'functions');
    mkdirSync(serviceRoot, { recursive: true });
    writeJson(join(serviceRoot, 'package.json'), {
      optionalDependencies: { '@microsoft/rayfin-functions': 'latest' },
      peerDependencies: { '@microsoft/rayfin-lib': '^2.0.0' },
    });
    writeInstalledPackage(
      serviceRoot,
      '@microsoft/rayfin-functions',
      '1.35.0-alpha'
    );
    writeInstalledPackage(serviceRoot, '@microsoft/rayfin-lib', '2.0.0');

    const result =
      await createCliProjectTelemetryService().collectDeploymentTelemetry(
        projectRoot,
        ['packages/functions']
      );

    expect(result.projectOriginId).toBeUndefined();
    expect(result.microsoftPackages).toHaveLength(4);
    expect(result.microsoftPackages).toEqual(
      expect.arrayContaining([
        { name: '@microsoft/rayfin-core', version: '1.35.0-alpha' },
        { name: '@microsoft/rayfin-functions', version: '1.35.0-alpha' },
        { name: '@microsoft/rayfin-lib', version: '1.0.0' },
        { name: '@microsoft/rayfin-lib', version: '2.0.0' },
      ])
    );
    expect(result.unresolvedPackageCount).toBe(0);
  });

  it('does not read package roots outside the project', async () => {
    writeProjectManifest({});
    const outsideRoot = mkdtempSync(join(tmpdir(), 'rayfin-outside-package-'));
    try {
      writeJson(join(outsideRoot, 'package.json'), {
        dependencies: { '@microsoft/rayfin-storage': '1.0.0' },
      });
      writeInstalledPackage(outsideRoot, '@microsoft/rayfin-storage', '1.0.0');

      const result =
        await createCliProjectTelemetryService().collectDeploymentTelemetry(
          projectRoot,
          [relative(projectRoot, outsideRoot)]
        );

      expect(result.microsoftPackages).toBeUndefined();
      expect(result.unresolvedPackageCount).toBeUndefined();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow configured package-root symlinks outside the project',
    async () => {
      writeProjectManifest({});
      const outsideRoot = mkdtempSync(
        join(tmpdir(), 'rayfin-outside-package-')
      );
      const linkRoot = join(projectRoot, 'packages', 'linked');
      try {
        mkdirSync(join(projectRoot, 'packages'), { recursive: true });
        writeJson(join(outsideRoot, 'package.json'), {
          dependencies: { '@microsoft/rayfin-storage': '1.0.0' },
        });
        writeInstalledPackage(
          outsideRoot,
          '@microsoft/rayfin-storage',
          '1.0.0'
        );
        symlinkSync(outsideRoot, linkRoot, 'dir');

        const result =
          await createCliProjectTelemetryService().collectDeploymentTelemetry(
            projectRoot,
            ['packages/linked']
          );

        expect(result.microsoftPackages).toBeUndefined();
        expect(result.unresolvedPackageCount).toBeUndefined();
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }
    }
  );

  it('preserves project inventory when a configured package root is missing', async () => {
    writeProjectManifest({
      dependencies: { '@microsoft/rayfin-core': '1.35.0-alpha' },
    });
    writeInstalledPackage(
      projectRoot,
      '@microsoft/rayfin-core',
      '1.35.0-alpha'
    );

    const result =
      await createCliProjectTelemetryService().collectDeploymentTelemetry(
        projectRoot,
        ['packages/missing']
      );

    expect(result.microsoftPackages).toEqual([
      { name: '@microsoft/rayfin-core', version: '1.35.0-alpha' },
    ]);
    expect(result.unresolvedPackageCount).toBe(0);
  });

  it('rejects malformed Microsoft dependency names', async () => {
    writeProjectManifest({
      dependencies: { '@microsoft/../../outside': '1.0.0' },
    });

    const result =
      await createCliProjectTelemetryService().collectDeploymentTelemetry(
        projectRoot,
        []
      );

    expect(result.microsoftPackages).toEqual([]);
  });

  it('reports malformed package manifests as unavailable inventory', async () => {
    writeFileSync(join(projectRoot, 'package.json'), 'not json');

    const result =
      await createCliProjectTelemetryService().collectDeploymentTelemetry(
        projectRoot,
        []
      );

    expect(result.microsoftPackages).toBeUndefined();
    expect(result.unresolvedPackageCount).toBeUndefined();
  });

  it('returns resolved packages and counts unresolved optional and peer declarations', async () => {
    writeProjectManifest({
      dependencies: {
        '@microsoft/rayfin-core': '1.35.0-alpha',
      },
      optionalDependencies: {
        '@microsoft/rayfin-storage': '1.0.0',
      },
      peerDependencies: {
        '@microsoft/rayfin-functions': '1.0.0',
      },
    });
    writeInstalledPackage(
      projectRoot,
      '@microsoft/rayfin-core',
      '1.35.0-alpha'
    );

    const result =
      await createCliProjectTelemetryService().collectDeploymentTelemetry(
        projectRoot,
        []
      );

    expect(result.microsoftPackages).toEqual([
      { name: '@microsoft/rayfin-core', version: '1.35.0-alpha' },
    ]);
    expect(result.unresolvedPackageCount).toBe(2);
  });

  it('deduplicates real roots and unresolved package names', async () => {
    writeProjectManifest({
      optionalDependencies: {
        '@microsoft/rayfin-storage': '1.0.0',
      },
    });
    const serviceRoot = join(projectRoot, 'packages', 'data');
    mkdirSync(serviceRoot, { recursive: true });
    writeJson(join(serviceRoot, 'package.json'), {
      peerDependencies: {
        '@microsoft/rayfin-storage': '1.0.0',
      },
    });

    const result =
      await createCliProjectTelemetryService().collectDeploymentTelemetry(
        projectRoot,
        ['.', './', 'packages/data', 'packages/data/.']
      );

    expect(result.microsoftPackages).toEqual([]);
    expect(result.unresolvedPackageCount).toBe(1);
  });

  function writeProjectManifest(manifest: Record<string, unknown>): void {
    writeJson(join(projectRoot, 'package.json'), manifest);
  }
});

function writeInstalledPackage(
  resolutionRoot: string,
  name: string,
  version: string
): void {
  const packageRoot = join(resolutionRoot, 'node_modules', ...name.split('/'));
  mkdirSync(packageRoot, { recursive: true });
  writeJson(join(packageRoot, 'package.json'), { name, version });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
