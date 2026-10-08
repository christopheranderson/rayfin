import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { loadEnv } from 'vite';

const projectRoot = path.resolve(import.meta.dirname, '../..');

export const E2E_FRONTEND_URL_ENV_VAR = 'E2E_FRONTEND_URL';

interface WaitForFrontendOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function resolveFrontendUrl(root: string = projectRoot): string {
  const rawPort = loadEnv('development', root, 'VITE_').VITE_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Frontend port is unavailable. Expected VITE_PORT in ${path.join(root, '.env.local')} after Rayfin dev startup.`
    );
  }
  return `http://localhost:${port}`;
}

export async function waitForFrontend(
  frontendUrl: string,
  options: WaitForFrontendOptions = {}
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    try {
      const requestTimeout = AbortSignal.timeout(1_000);
      const signal = options.signal
        ? AbortSignal.any([options.signal, requestTimeout])
        : requestTimeout;
      const response = await fetch(frontendUrl, { signal });
      if (response.ok) return;
    } catch {
      options.signal?.throwIfAborted();
    }
    await sleep(250, undefined, { signal: options.signal });
  }
  throw new Error(`Frontend did not become ready at ${frontendUrl}.`);
}

export function getFrontendUrl(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const frontendUrl = environment[E2E_FRONTEND_URL_ENV_VAR];
  if (!frontendUrl) {
    throw new Error(
      `${E2E_FRONTEND_URL_ENV_VAR} is not set by Playwright global setup.`
    );
  }
  return frontendUrl;
}
