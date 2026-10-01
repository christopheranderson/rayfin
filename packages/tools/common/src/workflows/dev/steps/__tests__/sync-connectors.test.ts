import { describe, expect, it, vi } from 'vitest';

import type { RayfinConfig } from '../../../../config/index.js';
import type { DevBackendProvider, DevTarget } from '../../providers/index.js';
import { syncConnectors } from '../sync-connectors.js';

const target: DevTarget = { provider: 'fabric', displayName: 'ws' };

function backend(
  overrides: Partial<DevBackendProvider> = {}
): DevBackendProvider {
  return {
    resolveTarget: vi.fn(),
    ensureReady: vi.fn(),
    applyDataConfig: vi.fn(),
    applyStorageConfig: vi.fn(),
    syncConnectors: vi.fn().mockResolvedValue(undefined),
    prepareForLocalFrontend: vi.fn(),
    teardown: vi.fn(),
    ...overrides,
  };
}

describe('syncConnectors', () => {
  it('syncs a valid (or empty) connectors block to the backend', async () => {
    const b = backend();

    const result = await syncConnectors(
      { target, connectors: undefined },
      { backend: b }
    );

    expect(result.status).toBe('synced');
    expect(b.syncConnectors).toHaveBeenCalledWith(target, undefined);
  });

  it('returns invalid-connectors without touching the backend', async () => {
    const b = backend();
    // A structurally valid array whose entry is missing `name` — validation
    // returns an error (it does not throw).
    const connectors = [{ name: '' }] as unknown as RayfinConfig['connectors'];

    const result = await syncConnectors({ target, connectors }, { backend: b });

    expect(result.status).toBe('invalid-connectors');
    expect(b.syncConnectors).not.toHaveBeenCalled();
  });
});
