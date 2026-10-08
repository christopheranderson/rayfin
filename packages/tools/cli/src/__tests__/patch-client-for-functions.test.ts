import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { patchClientForFunctions } from '../utils/patch-client-for-functions';

// ── Fixtures: exact CLI template output ────────────────────────────────

const TEMPLATE_RAYFIN_CLIENT = `import { RayfinClient } from '@microsoft/rayfin-client';

import type { DataAppSchema } from '../../rayfin/data/schema';

export interface RayfinClientConfig {
  baseUrl: string;
  publishableKey: string;
  /** True when the API URL points at localhost. Exposed via {@link isLocalBackend}. */
  localDev: boolean;
}

let client: RayfinClient<DataAppSchema> | null = null;
let localDev = false;

export function initRayfinClient(
  config: RayfinClientConfig
): RayfinClient<DataAppSchema> {
  if (client) {
    throw new Error('Rayfin client is already initialized.');
  }
  client = new RayfinClient<DataAppSchema>({
    baseUrl: config.baseUrl,
    publishableKey: config.publishableKey,
    authStorage: true,
  });
  localDev = config.localDev;
  return client;
}

export function getRayfinClient(): RayfinClient<DataAppSchema> {
  if (!client) {
    throw new Error(
      'Rayfin client not initialized. Call bootstrapAuth() first.'
    );
  }
  return client;
}

/** True when the app was bootstrapped against a localhost backend. */
export function isLocalBackend(): boolean {
  return localDev;
}
`;

const TEMPLATE_BOOTSTRAP = `import type { IAuthService } from './IAuthService';
import { MockAuthService } from './MockAuthService';
import { RayfinAuthService } from './RayfinAuthService';
import { initRayfinClient } from './rayfinClient';

function isLocalBackendUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function bootstrapAuth(): IAuthService {
  const apiUrl = import.meta.env.VITE_RAYFIN_API_URL || 'http://localhost:5168';
  const localDev = isLocalBackendUrl(apiUrl);
  const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY;

  if (!publishableKey && !localDev) {
    throw new Error(
      'VITE_RAYFIN_PUBLISHABLE_KEY environment variable is required'
    );
  }

  const client = initRayfinClient({
    baseUrl: apiUrl.endsWith('/') ? apiUrl : \`\${apiUrl}/\`,
    publishableKey: publishableKey ?? 'local-dev-key',
    localDev,
  });

  if (localDev) {
    return new MockAuthService(client);
  }

  return new RayfinAuthService(client, {
    workspaceId: import.meta.env.VITE_FABRIC_WORKSPACE_ID,
    projectId: import.meta.env.VITE_FABRIC_ITEM_ID,
    fabricPortalUrl: import.meta.env.VITE_FABRIC_PORTAL_URL,
    returnOrigin: window.location.origin,
  });
}
`;

describe('patchClientForFunctions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'patch-functions-'));
    await mkdir(join(tmpDir, 'src', 'services'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('patches standard template files successfully', async () => {
    await writeFile(
      join(tmpDir, 'src', 'services', 'rayfinClient.ts'),
      TEMPLATE_RAYFIN_CLIENT
    );
    await writeFile(
      join(tmpDir, 'src', 'services', 'bootstrap.ts'),
      TEMPLATE_BOOTSTRAP
    );

    const result = await patchClientForFunctions(tmpDir);

    expect(result.patched).toBe(true);
    expect(result.manual).toBe(false);
    expect(result.files).toHaveLength(2);
    expect(result.files).toContain(join('src', 'services', 'rayfinClient.ts'));
    expect(result.files).toContain(join('src', 'services', 'bootstrap.ts'));

    const clientContent = await readFile(
      join(tmpDir, 'src', 'services', 'rayfinClient.ts'),
      'utf8'
    );
    expect(clientContent).toContain('functionsBaseUrl?: string;');
    expect(clientContent).toContain(
      'functionsBaseUrl: config.functionsBaseUrl,'
    );

    const bootstrapContent = await readFile(
      join(tmpDir, 'src', 'services', 'bootstrap.ts'),
      'utf8'
    );
    expect(bootstrapContent).toContain(
      'functionsBaseUrl:\n' +
        '      import.meta.env.DEV\n' +
        '        ? import.meta.env.VITE_RAYFIN_FUNCTIONS_URL\n' +
        '        : undefined,'
    );
  });

  it('returns no-op when already patched', async () => {
    const alreadyPatched = TEMPLATE_RAYFIN_CLIENT.replace(
      'localDev: boolean;\n}',
      'localDev: boolean;\n  functionsBaseUrl?: string;\n}'
    );
    await writeFile(
      join(tmpDir, 'src', 'services', 'rayfinClient.ts'),
      alreadyPatched
    );
    await writeFile(
      join(tmpDir, 'src', 'services', 'bootstrap.ts'),
      TEMPLATE_BOOTSTRAP
    );

    const result = await patchClientForFunctions(tmpDir);

    expect(result.patched).toBe(false);
    expect(result.manual).toBe(false);
    expect(result.files).toHaveLength(0);
  });

  it('returns manual when rayfinClient.ts does not exist', async () => {
    await writeFile(
      join(tmpDir, 'src', 'services', 'bootstrap.ts'),
      TEMPLATE_BOOTSTRAP
    );

    const result = await patchClientForFunctions(tmpDir);

    expect(result.patched).toBe(false);
    expect(result.manual).toBe(true);
  });

  it('returns manual when bootstrap.ts does not exist', async () => {
    await writeFile(
      join(tmpDir, 'src', 'services', 'rayfinClient.ts'),
      TEMPLATE_RAYFIN_CLIENT
    );

    const result = await patchClientForFunctions(tmpDir);

    expect(result.patched).toBe(false);
    expect(result.manual).toBe(true);
  });

  it('returns manual when rayfinClient.ts has unrecognizable structure', async () => {
    await writeFile(
      join(tmpDir, 'src', 'services', 'rayfinClient.ts'),
      '// Completely custom client code\nexport const client = new SomeOtherClient();\n'
    );
    await writeFile(
      join(tmpDir, 'src', 'services', 'bootstrap.ts'),
      TEMPLATE_BOOTSTRAP
    );

    const result = await patchClientForFunctions(tmpDir);

    expect(result.patched).toBe(false);
    expect(result.manual).toBe(true);
  });

  it('returns manual when bootstrap.ts has unrecognizable structure', async () => {
    await writeFile(
      join(tmpDir, 'src', 'services', 'rayfinClient.ts'),
      TEMPLATE_RAYFIN_CLIENT
    );
    await writeFile(
      join(tmpDir, 'src', 'services', 'bootstrap.ts'),
      '// Custom bootstrap\nexport function setup() { return null; }\n'
    );

    const result = await patchClientForFunctions(tmpDir);

    expect(result.patched).toBe(false);
    expect(result.manual).toBe(true);

    // Verify rayfinClient.ts was NOT modified (atomic — neither file written)
    const clientContent = await readFile(
      join(tmpDir, 'src', 'services', 'rayfinClient.ts'),
      'utf8'
    );
    expect(clientContent).not.toContain('functionsBaseUrl');
  });

  it('is idempotent — second call is a no-op', async () => {
    await writeFile(
      join(tmpDir, 'src', 'services', 'rayfinClient.ts'),
      TEMPLATE_RAYFIN_CLIENT
    );
    await writeFile(
      join(tmpDir, 'src', 'services', 'bootstrap.ts'),
      TEMPLATE_BOOTSTRAP
    );

    const first = await patchClientForFunctions(tmpDir);
    expect(first.patched).toBe(true);

    const second = await patchClientForFunctions(tmpDir);
    expect(second.patched).toBe(false);
    expect(second.manual).toBe(false);
  });
});
