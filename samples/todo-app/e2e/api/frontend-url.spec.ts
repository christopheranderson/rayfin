import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  E2E_FRONTEND_URL_ENV_VAR,
  getFrontendUrl,
  resolveFrontendUrl,
} from '../shared/frontend';

describe('frontend URL', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-frontend-url-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('uses the non-default port written to .env.local', () => {
    writeFileSync(join(projectRoot, '.env.local'), 'VITE_PORT=5197\n');

    expect(resolveFrontendUrl(projectRoot)).toBe('http://localhost:5197');
  });

  it('reads the URL exported by Playwright global setup', () => {
    expect(
      getFrontendUrl({
        [E2E_FRONTEND_URL_ENV_VAR]: 'http://localhost:5197',
      })
    ).toBe('http://localhost:5197');
  });
});
