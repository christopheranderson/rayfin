import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  pollDeployStatus,
  handleDeployResult,
} from '../commands/up/functions/poll-deploy-status.js';
import { DeployState } from '../commands/up/functions/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function metadataResponse(
  deployStatus: DeployState,
  extra: Record<string, unknown> = {}
): Response {
  return jsonResponse({ deploy: { status: deployStatus, ...extra } });
}

describe('pollDeployStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns immediately when status is Complete', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      metadataResponse(DeployState.Complete)
    );

    const result = await pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 5,
      }
    );

    expect(result.status).toBe(DeployState.Complete);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns immediately when status is Fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      metadataResponse(DeployState.Fail, {
        error: 'Build failed',
        errorCode: 'USER_CODE_ERROR',
        isUserError: true,
      })
    );

    const result = await pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 5,
      }
    );

    expect(result.status).toBe(DeployState.Fail);
    expect(result.error).toBe('Build failed');
    expect(result.errorCode).toBe('USER_CODE_ERROR');
    expect(result.isUserError).toBe(true);
  });

  it('keeps polling until a terminal state is reached', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(metadataResponse(DeployState.InProgress))
      .mockResolvedValueOnce(metadataResponse(DeployState.InProgress))
      .mockResolvedValueOnce(metadataResponse(DeployState.Complete));

    const promise = pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 10,
      }
    );

    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result.status).toBe(DeployState.Complete);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries on transient HTTP errors (429, 503) within a poll attempt', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // First poll: 503 then 503 then success (within withRetry's 3 attempts)
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(metadataResponse(DeployState.Complete));

    const promise = pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 10,
      }
    );

    // withRetry uses exponential backoff (2s, 4s) between retries
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.status).toBe(DeployState.Complete);
    // All 3 calls happen within the first poll attempt (withRetry retries internally)
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after 3 consecutive network errors', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    const promise = pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 10,
      }
    );

    // withRetry uses exponential backoff (2s, 4s) between retries
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    // withRetry exhausts 3 attempts, then poll gives up entirely
    expect(result.status).toBe(DeployState.Fail);
    expect(result.error).toContain('multiple retries');
  });

  it('gives up after 3 consecutive non-retryable HTTP errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(null, { status: 500 });
    });

    const promise = pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 10,
      }
    );

    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    // 500 is not in the retryable list, so withRetry fails immediately
    expect(result.status).toBe(DeployState.Fail);
    expect(result.error).toContain('multiple retries');
  });

  it('retries on 404 (endpoint not yet available)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(metadataResponse(DeployState.Complete));

    const promise = pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 10,
      }
    );

    // withRetry uses exponential backoff (2s) before retry
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result.status).toBe(DeployState.Complete);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 404 up to 10 times before giving up', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(null, { status: 404 })
    );

    const promise = pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 5,
      }
    );

    // Advance enough for all 10 withRetry attempts with exponential backoff
    await vi.advanceTimersByTimeAsync(5_000_000);
    const result = await promise;

    expect(result.status).toBe(DeployState.Fail);
    expect(result.error).toContain('multiple retries');
    // 10 attempts within a single poll iteration (maxAttempts: 10 for 404)
    expect(globalThis.fetch).toHaveBeenCalledTimes(10);
  });

  it('synthesises a Fail result after poll budget is exhausted', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      metadataResponse(DeployState.InProgress)
    );

    const promise = pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 3,
      }
    );

    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.status).toBe(DeployState.Fail);
    expect(result.error).toContain('Timed out');
    expect(result.isUserError).toBe(false);
  });

  it('aborts on signal cancellation', async () => {
    vi.useRealTimers();
    const controller = new AbortController();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      metadataResponse(DeployState.InProgress)
    );

    const promise = pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 50,
        maxPolls: 100,
        signal: controller.signal,
      }
    );

    setTimeout(() => controller.abort(new Error('user cancelled')), 80);

    await expect(promise).rejects.toThrow('user cancelled');
  });

  it('aborts when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));

    await expect(
      pollDeployStatus(
        'http://test/metadata',
        {},
        {
          signal: controller.signal,
        }
      )
    ).rejects.toThrow('pre-aborted');
  });

  it('calls onPoll callback each iteration', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(metadataResponse(DeployState.InProgress))
      .mockResolvedValueOnce(metadataResponse(DeployState.Complete));

    const onPoll = vi.fn();
    const promise = pollDeployStatus(
      'http://test/metadata',
      {},
      {
        intervalMs: 10,
        maxPolls: 5,
        onPoll,
      }
    );

    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(onPoll).toHaveBeenCalledTimes(2);
    expect(onPoll).toHaveBeenNthCalledWith(1, 1, 5);
    expect(onPoll).toHaveBeenNthCalledWith(2, 2, 5);
  });

  it('passes headers to fetch', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(metadataResponse(DeployState.Complete));

    await pollDeployStatus(
      'http://test/metadata',
      { Authorization: 'Bearer token123' },
      { intervalMs: 10 }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://test/metadata',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token123' },
      })
    );
  });
});

describe('handleDeployResult', () => {
  it('calls succeed on Complete status', () => {
    const progress = { succeed: vi.fn(), fail: vi.fn() };
    const log = vi.fn();

    handleDeployResult({ status: DeployState.Complete }, progress, log);

    expect(progress.succeed).toHaveBeenCalledWith(
      'Functions deployed successfully'
    );
    expect(progress.fail).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('calls fail and logs error on Fail status', () => {
    const progress = { succeed: vi.fn(), fail: vi.fn() };
    const log = vi.fn();

    handleDeployResult(
      {
        status: DeployState.Fail,
        error: 'Something broke',
        errorCode: 'INTERNAL_ERROR',
        isUserError: false,
      },
      progress,
      log
    );

    expect(progress.fail).toHaveBeenCalledWith('Functions deployment failed');
    expect(progress.succeed).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Something broke')
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('INTERNAL_ERROR'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('service error'));
  });

  it('shows user error hint when isUserError is true', () => {
    const progress = { succeed: vi.fn(), fail: vi.fn() };
    const log = vi.fn();

    handleDeployResult(
      {
        status: DeployState.Fail,
        error: 'Syntax error in index.ts',
        isUserError: true,
      },
      progress,
      log
    );

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('caused by your project code')
    );
  });
});
