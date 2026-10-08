import { describe, expect, it, vi } from 'vitest';

import type { FrameworkEnvService } from '../../../../services/framework-env/index.js';
import { refreshFrameworkEnv } from '../refresh-framework-env.js';

function fakeFrameworkEnv(
  overrides: Partial<FrameworkEnvService> = {}
): FrameworkEnvService {
  return {
    detectFramework: vi.fn().mockResolvedValue(null),
    writeEnvFile: vi.fn(),
    ...overrides,
  };
}

describe('refreshFrameworkEnv', () => {
  it('returns no-framework when none is detected', async () => {
    const frameworkEnv = fakeFrameworkEnv();

    const result = await refreshFrameworkEnv(
      { projectRoot: '/p' },
      { frameworkEnv }
    );

    expect(result).toEqual({ status: 'no-framework' });
    expect(frameworkEnv.writeEnvFile).not.toHaveBeenCalled();
  });

  it('refreshes the env file when a framework is detected', async () => {
    const frameworkEnv = fakeFrameworkEnv({
      detectFramework: vi.fn().mockResolvedValue('vite'),
      writeEnvFile: vi.fn().mockResolvedValue('/p/.env.local'),
    });

    const result = await refreshFrameworkEnv(
      { projectRoot: '/p' },
      { frameworkEnv }
    );

    expect(frameworkEnv.writeEnvFile).toHaveBeenCalledWith({
      projectRoot: '/p',
      framework: 'vite',
      outputDir: '.',
    });
    expect(result).toEqual({
      status: 'refreshed',
      framework: 'vite',
      path: '/p/.env.local',
    });
  });

  it('uses the configured frontend for both detection and environment generation', async () => {
    const frameworkEnv = fakeFrameworkEnv({
      detectFramework: vi.fn().mockResolvedValue('vite'),
      writeEnvFile: vi
        .fn()
        .mockResolvedValue('/p/packages/frontend/.env.local'),
    });
    const staticHosting = {
      enabled: true,
      path: 'packages/frontend',
      folder: 'dist',
    };

    const result = await refreshFrameworkEnv(
      { projectRoot: '/p', staticHosting },
      { frameworkEnv }
    );

    expect(frameworkEnv.detectFramework).toHaveBeenCalledWith(
      '/p',
      staticHosting
    );
    expect(frameworkEnv.writeEnvFile).toHaveBeenCalledWith({
      projectRoot: '/p',
      framework: 'vite',
      staticHosting,
    });
    expect(result).toEqual({
      status: 'refreshed',
      framework: 'vite',
      path: '/p/packages/frontend/.env.local',
    });
  });

  it('returns a non-fatal failure when the write rejects', async () => {
    const frameworkEnv = fakeFrameworkEnv({
      detectFramework: vi.fn().mockResolvedValue('nextjs'),
      writeEnvFile: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    const result = await refreshFrameworkEnv(
      { projectRoot: '/p' },
      { frameworkEnv }
    );

    expect(result).toEqual({ status: 'failed', message: 'disk full' });
  });

  it('returns a non-fatal failure when detection itself rejects', async () => {
    const frameworkEnv = fakeFrameworkEnv({
      detectFramework: vi.fn().mockRejectedValue(new Error('fs unavailable')),
    });

    const result = await refreshFrameworkEnv(
      { projectRoot: '/p' },
      { frameworkEnv }
    );

    expect(result).toEqual({ status: 'failed', message: 'fs unavailable' });
    expect(frameworkEnv.writeEnvFile).not.toHaveBeenCalled();
  });
});
