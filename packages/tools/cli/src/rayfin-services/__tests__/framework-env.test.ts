/**
 * Unit coverage for the CLI {@link FrameworkEnvService} delegation. The impl
 * wraps the legacy `detectFrontendFramework` detector and the `writeFrameworkEnvFile`
 * writer; these tests pin the delegated arguments and the `outputDir` default
 * (`.`) so the contract mapping is caught by a fast unit test.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { WriteFrameworkEnvRequest } from '@microsoft/rayfin-tools-common/_internal/services/framework-env';
import { refreshFrameworkEnv } from '@microsoft/rayfin-tools-common/_internal/workflows/up';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../commands/env/env.js', () => ({
  writeFrameworkEnvFile: vi.fn(),
}));
vi.mock('../../utils/frontend-detect.js', () => ({
  detectFrontendFramework: vi.fn(),
}));

import { writeFrameworkEnvFile } from '../../commands/env/env.js';
import { detectFrontendFramework } from '../../utils/frontend-detect.js';
import { createCliFrameworkEnvService } from '../framework-env.js';

const mockWrite = writeFrameworkEnvFile as ReturnType<typeof vi.fn>;
const mockDetect = detectFrontendFramework as ReturnType<typeof vi.fn>;

describe('createCliFrameworkEnvService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('delegates detectFramework to detectFrontendFramework', async () => {
    mockDetect.mockReturnValue('vite');

    const result =
      await createCliFrameworkEnvService().detectFramework('/proj');

    expect(mockDetect).toHaveBeenCalledWith('/proj');
    expect(result).toBe('vite');
  });

  it('writes the env file with the request framework and defaults outputDir to "."', async () => {
    mockWrite.mockResolvedValue('/proj/.env.local');
    const request = {
      projectRoot: '/proj',
      framework: 'vite',
    } as WriteFrameworkEnvRequest;

    const path = await createCliFrameworkEnvService().writeEnvFile(request);

    expect(mockWrite).toHaveBeenCalledWith({
      projectRoot: '/proj',
      framework: 'vite',
      outputDir: '.',
    });
    expect(path).toBe('/proj/.env.local');
  });

  it('forwards an explicit outputDir', async () => {
    mockWrite.mockResolvedValue('/proj/web/.env.local');
    const request = {
      projectRoot: '/proj',
      framework: 'nextjs',
      outputDir: 'web',
    } as WriteFrameworkEnvRequest;

    await createCliFrameworkEnvService().writeEnvFile(request);

    expect(mockWrite).toHaveBeenCalledWith({
      projectRoot: '/proj',
      framework: 'nextjs',
      outputDir: 'web',
    });
  });

  it.each([
    { path: 'packages/frontend' },
    { root: 'frontend' },
    { path: 'packages/app', root: 'frontend' },
  ])(
    'generates the actual Vite environment at the configured frontend %j',
    async (location) => {
      const projectRoot = await mkdtemp(
        join(tmpdir(), 'rayfin-framework-env-')
      );
      const frontend = resolve(
        projectRoot,
        location.path ?? '.',
        location.root ?? '.'
      );
      try {
        await mkdir(join(projectRoot, 'rayfin'));
        await mkdir(frontend, { recursive: true });
        await writeFile(join(projectRoot, 'package.json'), '{"private":true}');
        await writeFile(
          join(frontend, 'package.json'),
          '{"devDependencies":{"vite":"^7.0.0"}}'
        );
        await writeFile(
          join(projectRoot, 'rayfin', '.env'),
          'RAYFIN_PUBLIC_API_URL=https://api.example.com\nRAYFIN_PUBLIC_WORKSPACE_ID=11111111-1111-4111-8111-111111111111\n'
        );
        const detector = await vi.importActual<
          typeof import('../../utils/frontend-detect.js')
        >('../../utils/frontend-detect.js');
        const writer = await vi.importActual<
          typeof import('../../commands/env/env.js')
        >('../../commands/env/env.js');
        mockDetect.mockImplementation(detector.detectFrontendFramework);
        mockWrite.mockImplementation(writer.writeFrameworkEnvFile);

        const result = await refreshFrameworkEnv(
          {
            projectRoot,
            staticHosting: { enabled: true, folder: 'dist', ...location },
          },
          { frameworkEnv: createCliFrameworkEnvService() }
        );

        expect(result).toEqual({
          status: 'refreshed',
          framework: 'vite',
          path: join(frontend, '.env.local'),
        });
        const content = await readFile(join(frontend, '.env.local'), 'utf8');
        expect(content).toContain(
          'VITE_RAYFIN_API_URL=https://api.example.com'
        );
        expect(content).toContain(
          'VITE_FABRIC_WORKSPACE_ID=11111111-1111-4111-8111-111111111111'
        );
        await expect(
          readFile(join(projectRoot, '.env.local'))
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await rm(join(frontend, 'package.json'));
        expect(
          await refreshFrameworkEnv(
            {
              projectRoot,
              staticHosting: { enabled: true, folder: 'dist', ...location },
            },
            { frameworkEnv: createCliFrameworkEnvService() }
          )
        ).toEqual({ status: 'no-framework' });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    }
  );

  it.each(['../outside', 'nested/../../outside'])(
    'does not detect or write through an escaping static-hosting root: %s',
    async (root) => {
      const projectRoot = await mkdtemp(
        join(tmpdir(), 'rayfin-framework-env-escape-')
      );
      const outside = join(projectRoot, 'outside');
      try {
        await mkdir(join(projectRoot, 'frontend'), { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(
          join(outside, 'package.json'),
          '{"devDependencies":{"vite":"^7.0.0"}}'
        );
        const staticHosting = {
          enabled: true,
          path: 'frontend',
          root,
          folder: 'dist',
        };
        const service = createCliFrameworkEnvService();

        await expect(
          service.detectFramework(projectRoot, staticHosting)
        ).rejects.toThrow(`root '${root}' escapes the service root`);
        expect(mockDetect).not.toHaveBeenCalled();

        expect(() =>
          service.writeEnvFile({
            projectRoot,
            framework: 'vite',
            staticHosting,
          })
        ).toThrow(`root '${root}' escapes the service root`);
        expect(mockWrite).not.toHaveBeenCalled();
        await expect(
          readFile(join(outside, '.env.local'))
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    }
  );
});
