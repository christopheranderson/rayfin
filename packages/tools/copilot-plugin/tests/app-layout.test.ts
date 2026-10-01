import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readAppPackageManifests,
  resolveServiceDirectory,
  resolveStaticSourcePath,
} from '../src/app-layout.js';

const directories: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly app: string;
  readonly outside: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rayfin-app-layout-'));
  directories.push(root);
  const app = path.join(root, 'app');
  const outside = path.join(root, 'outside');
  await Promise.all([
    mkdir(path.join(app, 'rayfin'), { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(app, 'package.json'), '{}\n', 'utf8'),
    writeFile(path.join(app, 'rayfin', 'rayfin.yml'), 'services: {}\n', 'utf8'),
  ]);
  return { root, app, outside };
}

async function linkDirectory(target: string, link: string): Promise<void> {
  await symlink(
    target,
    link,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('app path containment', () => {
  it('rejects lexical traversal before inspecting the filesystem', async () => {
    const { app } = await fixture();

    await expect(
      resolveServiceDirectory(app, 'data', '../outside')
    ).rejects.toThrow('services.data.path must stay inside the app root');
  });

  it('rejects an existing workspace member linked outside the app', async () => {
    const { app, outside } = await fixture();
    await mkdir(path.join(app, 'packages'));
    await writeFile(path.join(outside, 'package.json'), '{}\n', 'utf8');
    await linkDirectory(outside, path.join(app, 'packages', 'frontend'));
    await writeFile(
      path.join(app, 'package.json'),
      JSON.stringify({ workspaces: ['packages/frontend'] }),
      'utf8'
    );

    await expect(readAppPackageManifests(app)).rejects.toThrow(
      /resolves outside the app root through a symbolic link or junction/u
    );
  });

  it('rejects an existing configured service linked outside the app', async () => {
    const { app, outside } = await fixture();
    await mkdir(path.join(app, 'packages'));
    await linkDirectory(outside, path.join(app, 'packages', 'data'));
    await writeFile(
      path.join(app, 'rayfin', 'rayfin.yml'),
      'services:\n  data:\n    path: packages/data\n',
      'utf8'
    );

    await expect(
      resolveServiceDirectory(app, 'data', 'rayfin/data')
    ).rejects.toThrow(
      /resolves outside the app root through a symbolic link or junction/u
    );
  });

  it('accepts an in-root workspace member reached through a directory link', async () => {
    const { app } = await fixture();
    const member = path.join(app, 'members', 'frontend');
    await Promise.all([
      mkdir(member, { recursive: true }),
      mkdir(path.join(app, 'packages'), { recursive: true }),
    ]);
    await writeFile(path.join(member, 'package.json'), '{}\n', 'utf8');
    await linkDirectory(member, path.join(app, 'packages', 'frontend'));
    await writeFile(
      path.join(app, 'package.json'),
      JSON.stringify({ workspaces: ['packages/frontend'] }),
      'utf8'
    );

    const manifests = await readAppPackageManifests(app);

    expect(manifests.members).toHaveLength(1);
    expect(manifests.members[0]?.directory).toBe(await realpath(member));
  });

  it('rejects a new generated file below an escaping directory link', async () => {
    const { app, outside } = await fixture();
    await linkDirectory(outside, path.join(app, 'src'));

    await expect(
      resolveStaticSourcePath(
        app,
        path.join('src', 'fabric.generated.ts'),
        'Generated Fabric configuration'
      )
    ).rejects.toThrow(
      /resolves outside the app root through a symbolic link or junction/u
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects an escaping Windows junction without elevated privileges',
    async () => {
      const { app, outside } = await fixture();
      await symlink(outside, path.join(app, 'junction'), 'junction');

      await expect(
        resolveStaticSourcePath(
          app,
          path.join('junction', 'generated.ts'),
          'Generated output'
        )
      ).rejects.toThrow(
        /resolves outside the app root through a symbolic link or junction/u
      );
    }
  );
});
