import { describe, expect, it } from 'vitest';

import type { RayfinConfig } from '../../../../config/index.js';
import type { UpRequest } from '../../types.js';
import { validateRequest } from '../validate-request.js';

function request(overrides: Partial<UpRequest> = {}): UpRequest {
  return {
    config: { id: 'my-app' } as unknown as RayfinConfig,
    itemName: 'my-app',
    projectRoot: '/p',
    workspaceId: 'w1',
    portalBaseUrl: 'https://portal',
    ...overrides,
  };
}

describe('validateRequest', () => {
  it('accepts a well-formed request', async () => {
    const result = await validateRequest(request(), {});
    expect(result).toEqual({ status: 'valid' });
  });

  it('rejects a request with no project id', async () => {
    const result = await validateRequest(
      request({ config: { id: '  ' } as unknown as RayfinConfig }),
      {}
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors[0]).toContain('Project name not found');
    }
  });

  it('rejects an empty Fabric item name', async () => {
    const result = await validateRequest(request({ itemName: '   ' }), {});

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors).toContain(
        'Fabric item name cannot be empty. Pass a non-empty value with --item-name <name>.'
      );
    }
  });

  it('rejects a request with no workspace targeting', async () => {
    const result = await validateRequest(
      request({ workspaceId: undefined, workspaceName: undefined }),
      {}
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors.some((e) => e.includes('targeting'))).toBe(true);
    }
  });

  it('still requires workspace targeting even with a known item id', async () => {
    const result = await validateRequest(
      request({ workspaceId: undefined, knownItemId: 'i1' }),
      {}
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors.some((e) => e.includes('targeting'))).toBe(true);
    }
  });

  it('accepts a request with no configured portal base URL', async () => {
    const result = await validateRequest(
      request({ portalBaseUrl: undefined }),
      {}
    );
    expect(result).toEqual({ status: 'valid' });
  });

  it('rejects storage when data is disabled', async () => {
    const result = await validateRequest(
      request({
        config: {
          id: 'my-app',
          services: {
            data: { enabled: false },
            storage: { enabled: true },
          },
        } as unknown as RayfinConfig,
      }),
      {}
    );

    expect(result).toEqual({
      status: 'invalid',
      errors: [
        'Storage requires the Data service.\n' +
          '   Enable services.data or disable services.storage in rayfin.yml.',
      ],
    });
  });
});
