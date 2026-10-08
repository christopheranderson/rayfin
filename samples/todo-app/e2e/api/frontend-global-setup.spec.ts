import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { E2E_FRONTEND_URL_ENV_VAR } from '../shared/frontend';
import globalSetup from '../ui/global-setup';

const mocks = vi.hoisted(() => ({
  ensureBackendRunning: vi.fn(),
  resolveFrontendUrl: vi.fn(),
}));

vi.mock('../shared/backend', () => ({
  ensureBackendRunning: mocks.ensureBackendRunning,
}));
vi.mock('../shared/frontend', async (importActual) => ({
  ...(await importActual<typeof import('../shared/frontend')>()),
  resolveFrontendUrl: mocks.resolveFrontendUrl,
}));

describe('frontend global setup', () => {
  let originalFrontendUrl: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFrontendUrl = process.env[E2E_FRONTEND_URL_ENV_VAR];
    mocks.ensureBackendRunning.mockResolvedValue(undefined);
    mocks.resolveFrontendUrl.mockReturnValue('http://localhost:5197');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalFrontendUrl === undefined) {
      delete process.env[E2E_FRONTEND_URL_ENV_VAR];
    } else {
      process.env[E2E_FRONTEND_URL_ENV_VAR] = originalFrontendUrl;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('waits for and exports the workflow-selected frontend URL', async () => {
    await globalSetup();

    expect(mocks.ensureBackendRunning).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:5197',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(process.env[E2E_FRONTEND_URL_ENV_VAR]).toBe('http://localhost:5197');
  });
});
