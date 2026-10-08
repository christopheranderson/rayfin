import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';

import { fabricFetch } from '../../../utils/http-client.js';
import {
  withRetry,
  HttpError,
  parseRetryAfterHeader,
} from '../../../utils/retry-utils.js';

import {
  DeployState,
  type DeployInfo,
  type FunctionSetExternalMetadata,
} from './types.js';

/** Default interval between polls, in milliseconds. */
const POLL_INTERVAL_MS = 10_000;

/** Default maximum number of polls before timing out (~5 min at 10 s intervals). */
const MAX_POLLS = 30;

/**
 * Options accepted by {@link pollDeployStatus}.
 */
export interface PollDeployStatusOptions {
  diagnostics?: Diagnostics;
  /** Interval between polls in ms. Defaults to {@link POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Maximum number of poll attempts. Defaults to {@link MAX_POLLS}. */
  maxPolls?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Verbose diagnostic logger; defaults to a no-op. */
  verbose?: (...args: unknown[]) => void;
  /** Called at the start of each poll attempt with `(attempt, maxPolls)`. */
  onPoll?: (attempt: number, maxPolls: number) => void;
}

/**
 * Polls the FuncSet metadata endpoint until the deployment reaches a
 * terminal state (`Complete` or `Fail`) or the poll budget is exhausted.
 *
 * @param metadataUrl - Fully-qualified metadata URL
 *   (e.g. `<itemEndpoint>/__private/functions/metadata`).
 * @param headers - Headers to include on every request (Authorization, moniker, etc.).
 * @param options - Polling tunables and an optional AbortSignal.
 * @returns The final {@link DeployInfo} from the metadata response.
 */
export async function pollDeployStatus(
  metadataUrl: string,
  headers: Record<string, string>,
  options: PollDeployStatusOptions = {}
): Promise<DeployInfo> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const maxPolls = options.maxPolls ?? MAX_POLLS;
  const verbose = options.verbose ?? (() => {});

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    options.signal?.throwIfAborted();

    options.onPoll?.(attempt, maxPolls);
    options.diagnostics?.debug({
      area: 'functions.poll',
      message: 'Checking deployment status',
      data: { attempt, maxPolls },
    });

    let nonNotFoundRetries = 0;
    const resp = await withRetry(
      async () => {
        const resp = await fabricFetch(
          metadataUrl,
          {
            method: 'GET',
            headers,
            signal: options.signal,
          },
          options.diagnostics
        );
        if (!resp.ok) {
          throw new HttpError(
            `Metadata request failed: ${resp.status} ${resp.statusText}`,
            resp.status,
            parseRetryAfterHeader(resp)
          );
        }

        return resp;
      },
      {
        label: 'poll-deploy-metadata',
        // Suppress the inner retry's per-attempt verbose lines; the outer
        // poll loop already surfaces progress through the spinner.
        verbose: (message) =>
          options.diagnostics?.debug({
            area: 'functions.poll.retry',
            message: String(message),
          }),
        maxAttempts: 10,
        shouldRetry: (error) => {
          if (error instanceof HttpError) {
            // 404: known issue where endpoint may not be available yet — allow up to 10 retries.
            if (error.statusCode === 404) return true;
            // 408/425/429/502/503: transient — allow up to 3 retries then stop.
            if ([408, 425, 429, 502, 503].includes(error.statusCode)) {
              return nonNotFoundRetries++ < 2;
            }
            return false;
          }
          // Network errors: allow up to 3 retries then stop.
          return nonNotFoundRetries++ < 2;
        },
      }
    ).catch((error) => {
      // If all retries are exhausted, give up entirely.
      verbose(`Poll failed after retries: ${(error as Error).message}`);
      return null;
    });

    if (!resp) {
      return {
        status: DeployState.Fail,
        error:
          'Failed to reach the deployment metadata endpoint after multiple retries. ' +
          'Check network connectivity and the Fabric portal for the current status.',
        isUserError: false,
      };
    }

    const body = (await resp.json()) as FunctionSetExternalMetadata;
    const deploy = body.deploy;
    verbose(`Deploy status: ${deploy.status}`);
    options.diagnostics?.debug({
      area: 'functions.poll',
      message: 'Deployment status received',
      data: {
        complete: deploy.status === DeployState.Complete,
        failed: deploy.status === DeployState.Fail,
      },
    });

    if (
      deploy.status === DeployState.Complete ||
      deploy.status === DeployState.Fail
    ) {
      return deploy;
    }

    // Wait before the next poll (skip wait after final attempt).
    if (attempt < maxPolls) {
      await delay(intervalMs, options.signal);
    }
  }

  // Budget exhausted — synthesise a Fail result.
  return {
    status: DeployState.Fail,
    error:
      `Timed out after ${maxPolls} polls (~${Math.round((maxPolls * intervalMs) / 60_000)} min) ` +
      'waiting for the deployment to finish. Check the Fabric portal for the current status.',
    isUserError: false,
  };
}

// ---------------------------------------------------------------------------
// Result display
// ---------------------------------------------------------------------------

/**
 * Logs the outcome of a FuncSet deployment to a progress indicator.
 *
 * @param deploy - Final deployment info (terminal state).
 * @param progress - The active spinner / progress indicator to succeed or fail.
 * @param log - Logger for additional detail lines (defaults to `console.error`).
 */
export function handleDeployResult(
  deploy: DeployInfo,
  progress: { succeed: (msg?: string) => void; fail: (msg?: string) => void },
  log: (msg: string) => void = (m) => console.log(m)
): void {
  if (deploy.status === DeployState.Complete) {
    progress.succeed('Functions deployed successfully');
    return;
  }

  // Fail path
  progress.fail('Functions deployment failed');

  if (deploy.error) {
    log(`  Error: ${deploy.error}`);
  }
  if (deploy.errorCode) {
    log(`  Code:  ${deploy.errorCode}`);
  }
  if (deploy.isUserError) {
    log(
      '  This appears to be caused by your project code. Review the error above and retry with: rayfin up functions deploy'
    );
  } else {
    log(
      '  This appears to be a service error. Please retry with: rayfin up functions deploy'
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Awaits `ms` milliseconds, honouring an optional {@link AbortSignal}.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}
