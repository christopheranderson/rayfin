import type { StaticHostingConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../utils/runtime-config-file.js', () => ({
  writeRuntimeConfigFile: vi.fn(),
  removeRuntimeConfigFile: vi.fn(),
}));

vi.mock('../../utils/config-utils.js', () => ({
  resolveServiceRoot: vi.fn(
    (projectRoot: string, _serviceName: string, servicePath: string) =>
      servicePath === '.' ? projectRoot : `${projectRoot}/${servicePath}`
  ),
  resolveServiceSubpath: vi.fn(
    (
      serviceRoot: string,
      _serviceName: string,
      _fieldName: string,
      configuredPath: string
    ) =>
      configuredPath === '.' ? serviceRoot : `${serviceRoot}/${configuredPath}`
  ),
}));

import {
  resolveServiceRoot,
  resolveServiceSubpath,
} from '../../utils/config-utils.js';
import {
  removeRuntimeConfigFile,
  writeRuntimeConfigFile,
} from '../../utils/runtime-config-file.js';
import { createCliRuntimeConfigService } from '../runtime-config.js';

const mockResolveServiceRoot = resolveServiceRoot as ReturnType<typeof vi.fn>;
const mockResolveServiceSubpath = resolveServiceSubpath as ReturnType<
  typeof vi.fn
>;
const mockWrite = writeRuntimeConfigFile as ReturnType<typeof vi.fn>;
const mockRemove = removeRuntimeConfigFile as ReturnType<typeof vi.fn>;

const config: StaticHostingConfig = { enabled: true, folder: 'dist' };

describe('createCliRuntimeConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes into the resolved static-hosting public directory', async () => {
    const written = {
      path: '/p/public/rayfin.config.json',
      preexisting: false,
    };
    mockWrite.mockResolvedValue(written);

    const values = { apiUrl: 'https://baas/i1', itemId: 'i1' };
    const result = await createCliRuntimeConfigService().write(
      '/p',
      config,
      values
    );

    expect(mockResolveServiceRoot).toHaveBeenCalledWith(
      '/p',
      'staticHosting',
      '.'
    );
    expect(mockResolveServiceSubpath).toHaveBeenCalledWith(
      '/p',
      'staticHosting',
      'root',
      '.'
    );
    expect(mockWrite).toHaveBeenCalledWith('/p/public', values);
    expect(result).toBe(written);
  });

  it('resolves a non-default service path before appending public', async () => {
    mockWrite.mockResolvedValue({ path: 'irrelevant', preexisting: false });

    await createCliRuntimeConfigService().write(
      '/p',
      { ...config, path: 'apps/web' },
      { apiUrl: 'https://baas/i1' }
    );

    expect(mockResolveServiceRoot).toHaveBeenCalledWith(
      '/p',
      'staticHosting',
      'apps/web'
    );
    expect(mockWrite).toHaveBeenCalledWith(
      '/p/apps/web/public',
      expect.anything()
    );
  });

  it('writes under config.root, matching where the build copies public/ from', async () => {
    mockWrite.mockResolvedValue({ path: 'irrelevant', preexisting: false });

    await createCliRuntimeConfigService().write(
      '/p',
      { ...config, root: 'frontend' },
      { apiUrl: 'https://baas/i1' }
    );

    expect(mockWrite).toHaveBeenCalledWith(
      '/p/frontend/public',
      expect.anything()
    );
  });

  it('delegates remove to the util', async () => {
    await createCliRuntimeConfigService().remove(
      '/p/public/rayfin.config.json'
    );

    expect(mockRemove).toHaveBeenCalledWith('/p/public/rayfin.config.json');
  });
});
