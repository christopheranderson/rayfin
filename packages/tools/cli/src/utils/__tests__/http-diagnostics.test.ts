import { afterEach, describe, expect, it, vi } from 'vitest';

import { pollDeployStatus } from '../../commands/up/functions/poll-deploy-status.js';
import { DeployState } from '../../commands/up/functions/types.js';
import { fabricFetch } from '../http-client.js';

vi.mock('../../telemetry/enrichment.js', () => ({
  recordFabricResponseActivity: vi.fn(),
}));
afterEach(() => vi.unstubAllGlobals());

describe('HTTP diagnostics', () => {
  it('records functions polling without persisting response fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            deploy: {
              status: DeployState.Complete,
              privateData: 'private response',
            },
          })
        )
      )
    );
    const debug = vi.fn();
    await pollDeployStatus(
      'https://private-host/',
      { Authorization: 'Bearer credential' },
      { diagnostics: { debug }, maxPolls: 1 }
    );
    expect(debug).toHaveBeenCalledWith({
      area: 'http',
      message: 'Response received',
      data: { method: 'GET', status: 200, durationMs: expect.any(Number) },
    });
    expect(debug).toHaveBeenLastCalledWith({
      area: 'functions.poll',
      message: 'Deployment status received',
      data: { complete: true, failed: false },
    });
    expect(JSON.stringify(debug.mock.calls)).not.toMatch(/private|credential/);
  });

  it('records status and duration without URLs, bodies, or credentials', async () => {
    const response = new Response('private response', { status: 503 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const debug = vi.fn();
    await expect(
      fabricFetch(
        'https://private-host/?sig=credential',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer credential' },
          body: 'private payload',
        },
        { debug }
      )
    ).resolves.toBe(response);
    expect(debug).toHaveBeenLastCalledWith({
      area: 'http',
      message: 'Response received',
      data: { method: 'POST', status: 503, durationMs: expect.any(Number) },
    });
    expect(JSON.stringify(debug.mock.calls)).not.toMatch(/private|credential/);
  });

  it('preserves transport failures without logging their raw messages', async () => {
    const failure = new Error('private endpoint failure');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    const debug = vi.fn();
    await expect(
      fabricFetch('https://private-host/', undefined, { debug })
    ).rejects.toBe(failure);
    expect(debug).toHaveBeenLastCalledWith({
      area: 'http',
      message: 'Request failed',
      data: {
        method: 'GET',
        errorType: 'Error',
        durationMs: expect.any(Number),
      },
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
  });
});
