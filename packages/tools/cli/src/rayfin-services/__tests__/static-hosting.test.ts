import type { StaticHostingConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../utils/static-hosting-utils.js', () => ({
  validateStaticFolder: vi.fn(),
  runStaticBuildCommand: vi.fn(),
  packageStaticFolder: vi.fn(),
  deployStaticContent: vi.fn(),
}));

vi.mock('../../utils/hosting-url-utils.js', () => ({
  persistHostingUrlState: vi.fn(),
}));

vi.mock('../../utils/config-utils.js', () => ({
  resolveServiceRoot: vi.fn((projectRoot: string) => projectRoot),
  writeRayfinConfigUpdates: vi.fn(() => ({ status: 'updated' })),
}));

import { persistHostingUrlState } from '../../utils/hosting-url-utils.js';
import {
  deployStaticContent,
  packageStaticFolder,
  runStaticBuildCommand,
  validateStaticFolder,
} from '../../utils/static-hosting-utils.js';
import { createCliStaticHostingService } from '../static-hosting.js';

const mockValidate = validateStaticFolder as ReturnType<typeof vi.fn>;
const mockBuild = runStaticBuildCommand as ReturnType<typeof vi.fn>;
const mockPackage = packageStaticFolder as ReturnType<typeof vi.fn>;
const mockDeploy = deployStaticContent as ReturnType<typeof vi.fn>;
const mockPersist = persistHostingUrlState as ReturnType<typeof vi.fn>;

const config: StaticHostingConfig = { enabled: true, folder: 'dist' };

describe('createCliStaticHostingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates validateFolder to the util', async () => {
    const validation = {
      exists: true,
      empty: false,
      resolvedPath: '/p/dist',
      fileCount: 3,
      totalSizeBytes: 99,
    };
    mockValidate.mockReturnValue(validation);

    const result = await createCliStaticHostingService().validateFolder(
      '/p',
      config
    );

    expect(mockValidate).toHaveBeenCalledWith('/p', config);
    expect(result).toBe(validation);
  });

  it('surfaces a synchronous util throw as a rejection (catchable via .catch)', async () => {
    // The util can throw synchronously mid-walk (e.g. EACCES on a subdir). The
    // async body must convert that into a rejected promise rather than throwing
    // at the call site, so a `.catch()` consumer does not miss it.
    mockValidate.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const service = createCliStaticHostingService();
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = service.validateFolder('/p', config);
    }).not.toThrow();
    await expect(returned).rejects.toThrow('EACCES');
  });

  it('delegates runBuild to the util', async () => {
    mockBuild.mockResolvedValue(true);

    const result = await createCliStaticHostingService().runBuild('/p', config);

    expect(mockBuild).toHaveBeenCalledWith('/p', config, {
      output: 'on-failure',
      diagnostics: undefined,
    });
    expect(result).toBe(true);
  });

  it('captures the build when requested without a diagnostic sink', async () => {
    mockBuild.mockResolvedValue(true);

    await createCliStaticHostingService({ captureOutput: true }).runBuild(
      '/p',
      config
    );

    expect(mockBuild).toHaveBeenCalledWith('/p', config, {
      output: 'capture',
      diagnostics: undefined,
    });
  });

  it('forwards a diagnostic sink without changing the output policy', async () => {
    mockBuild.mockResolvedValue(true);
    const diagnostics = { debug: vi.fn() };

    await createCliStaticHostingService({ diagnostics }).runBuild('/p', config);

    expect(mockBuild).toHaveBeenCalledWith('/p', config, {
      output: 'on-failure',
      diagnostics,
    });
  });

  it('delegates packageFolder to the util', async () => {
    const buffer = Buffer.from('zip-bytes');
    mockPackage.mockResolvedValue(buffer);

    const result =
      await createCliStaticHostingService().packageFolder('/p/dist');

    expect(mockPackage).toHaveBeenCalledWith('/p/dist');
    expect(result).toBe(buffer);
  });

  it('bridges a Uint8Array payload to the Buffer-typed deploy util', async () => {
    const deployResult = {
      success: true,
      hostingUrl: 'https://app.test',
      errorMessage: null,
    };
    mockDeploy.mockResolvedValue(deployResult);
    const pkg = new Uint8Array([1, 2, 3]);

    const result = await createCliStaticHostingService().deploy(
      pkg,
      'https://deploy.test',
      'Bearer t',
      { 'x-extra': '1' }
    );

    expect(result).toBe(deployResult);
    const [passedBuffer, endpoint, auth, extra] = mockDeploy.mock.calls[0];
    expect(Buffer.isBuffer(passedBuffer)).toBe(true);
    expect(Uint8Array.from(passedBuffer)).toEqual(pkg);
    expect(endpoint).toBe('https://deploy.test');
    expect(auth).toBe('Bearer t');
    expect(extra).toEqual({ 'x-extra': '1' });
  });

  it('delegates persistHostingUrl to the util', async () => {
    mockPersist.mockResolvedValue({
      configUpdated: true,
      redirectUriUpdated: true,
      workspaceKey: 'ws',
      warnings: [],
    });
    const request = {
      hostingUrl: 'https://app.test',
      services: { auth: { enabled: false }, data: { enabled: true } },
      projectRoot: '/p',
      workspaceName: 'ws',
    };

    const result =
      await createCliStaticHostingService().persistHostingUrl(request);

    expect(mockPersist).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({ configUpdated: true, workspaceKey: 'ws' });
  });

  it('returns redirect-URI warnings without writing diagnostics', async () => {
    mockPersist.mockResolvedValue({
      configUpdated: true,
      redirectUriUpdated: false,
      warnings: ['Could not update redirect URIs'],
    });
    const diagnostics = { debug: vi.fn() };
    const request = {
      hostingUrl: 'https://app.test',
      services: { auth: { enabled: false }, data: { enabled: true } },
      projectRoot: '/p',
      workspaceName: 'ws',
    };

    const result = await createCliStaticHostingService({
      diagnostics,
    }).persistHostingUrl(request);

    expect(result.warnings).toEqual(['Could not update redirect URIs']);
    expect(diagnostics.debug).not.toHaveBeenCalled();
  });
});
