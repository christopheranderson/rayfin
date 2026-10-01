import { describe, expect, it, vi } from 'vitest';

import type { RayfinConfig } from '../../../../config/index.js';
import type { DevRedirectService } from '../../../../services/dev-redirect/index.js';
import { ensureLocalDevRedirectUris } from '../ensure-local-dev-redirect-uris.js';

function services(authEnabled: boolean): RayfinConfig['services'] {
  return {
    auth: { enabled: authEnabled },
    data: { enabled: false },
  } as unknown as RayfinConfig['services'];
}

function fakeDevRedirect(
  overrides: Partial<DevRedirectService> = {}
): DevRedirectService {
  return {
    resolveFrontendDevPort: vi
      .fn()
      .mockResolvedValue({ port: 5173, redirectPorts: [5173] }),
    appendLocalDevRedirectUris: vi.fn(),
    ...overrides,
  };
}

describe('ensureLocalDevRedirectUris', () => {
  it('resolves the port but passes services through when auth is disabled', async () => {
    const devRedirect = fakeDevRedirect();
    const input = { services: services(false), projectRoot: '/p' };

    const result = await ensureLocalDevRedirectUris(input, { devRedirect });

    expect(result).toEqual({ services: input.services });
    expect(devRedirect.resolveFrontendDevPort).toHaveBeenCalledWith('/p');
    expect(devRedirect.appendLocalDevRedirectUris).not.toHaveBeenCalled();
  });

  it('returns the augmented services when auth is enabled', async () => {
    const input = { services: services(true), projectRoot: '/p' };
    const augmented = {
      auth: { enabled: true, allowedRedirectUris: ['http://localhost:5173'] },
      data: { enabled: false },
    } as unknown as RayfinConfig['services'];
    const devRedirect = fakeDevRedirect({
      appendLocalDevRedirectUris: vi.fn().mockReturnValue(augmented),
    });

    const result = await ensureLocalDevRedirectUris(input, { devRedirect });

    expect(devRedirect.appendLocalDevRedirectUris).toHaveBeenCalledWith(
      input.services,
      5173
    );
    expect(result).toEqual({ services: augmented });
  });

  it('appends every retained redirect port in resolution order', async () => {
    const input = { services: services(true), projectRoot: '/p' };
    const appendLocalDevRedirectUris = vi
      .fn()
      .mockImplementation((current) => current);
    const devRedirect = fakeDevRedirect({
      resolveFrontendDevPort: vi
        .fn()
        .mockResolvedValue({ port: 5174, redirectPorts: [5174, 5173] }),
      appendLocalDevRedirectUris,
    });

    await ensureLocalDevRedirectUris(input, { devRedirect });

    expect(appendLocalDevRedirectUris).toHaveBeenNthCalledWith(
      1,
      input.services,
      5174
    );
    expect(appendLocalDevRedirectUris).toHaveBeenNthCalledWith(
      2,
      input.services,
      5173
    );
  });

  it('returns the original services with a warning when the append rejects', async () => {
    const input = { services: services(true), projectRoot: '/p' };
    const devRedirect = fakeDevRedirect({
      resolveFrontendDevPort: vi
        .fn()
        .mockRejectedValue(new Error('no free port')),
    });

    const result = await ensureLocalDevRedirectUris(input, { devRedirect });

    expect(result).toEqual({
      services: input.services,
      warning: 'no free port',
    });
  });
});
