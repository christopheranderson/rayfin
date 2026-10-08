import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { StorageApplyError } from '@microsoft/rayfin-tools-common/_internal/services/storage';
import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentContext } from '../telemetry/context-store.js';
import { applyStorageConfigToServer } from '../utils/storage-apply.js';

// Simple in-memory fetch mock
const fetchMock = vi.fn();
// @ts-ignore override global for test
global.fetch = fetchMock;

// Mock crypto.randomUUID
vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => 'test-correlation-id'),
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<any>('fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

describe('applyStorageConfigToServer', () => {
  const tmpConfigPath = join(process.cwd(), 'tmp-storage-config.json');

  beforeEach(() => {
    vi.resetAllMocks();
    (existsSync as any).mockReturnValue(true);
    const config = {
      schemaVersion: 1,
      folders: [
        {
          name: 'example',
          displayName: 'Example',
          onConflict: 'error',
          rules: [],
        },
      ],
    };
    (readFileSync as any).mockReturnValue(JSON.stringify(config));
  });

  afterEach(() => {
    setCurrentContext(undefined);
  });

  it('succeeds on 200 response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: true,
            manifestVersion: 3,
            createdFolders: ['example'],
            replacedFolders: [],
            removedFolders: [],
            warnings: [],
            correlationId: 'test-correlation-id',
          })
        ),
    });

    await applyStorageConfigToServer(tmpConfigPath);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toContain('/api/applystorageconfig');
  });

  it('does not POST an empty generated storage manifest', async () => {
    (readFileSync as any).mockReturnValue(
      JSON.stringify({ schemaVersion: 1, folders: [] })
    );

    await applyStorageConfigToServer(tmpConfigPath);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not write status output in silent mode', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: true,
            manifestVersion: 3,
            createdFolders: ['example'],
            replacedFolders: [],
            removedFolders: [],
            warnings: [],
          })
        ),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await applyStorageConfigToServer(
        tmpConfigPath,
        'https://api/item/__private/applystorageconfig',
        false,
        false,
        undefined,
        { mode: 'silent' }
      );
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('throws actionable 409 guidance listing blocked folders', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: false,
            error: 'RemovalBlocked',
            removalsBlocked: ['photos', 'archive'],
          })
        ),
    });
    const apply = applyStorageConfigToServer(tmpConfigPath);
    await expect(apply).rejects.toThrow(
      /blocked \(409\)[\s\S]*photos[\s\S]*archive[\s\S]*--force/
    );
    await expect(apply).rejects.toMatchObject({
      status: 409,
      code: 'removal-blocked',
    } satisfies Partial<StorageApplyError>);
  });

  it('uses the server message when a 409 response has no blocked-folder list', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: 'RemovalBlocked',
            message:
              '2 folder(s) cannot be removed because they still contain objects: photos, archive.',
          })
        ),
    });

    await expect(applyStorageConfigToServer(tmpConfigPath)).rejects.toThrow(
      /blocked \(409\)[\s\S]*photos, archive[\s\S]*--force/
    );
  });

  it('throws friendly 404 guidance', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve(''),
    });
    await expect(applyStorageConfigToServer(tmpConfigPath)).rejects.toThrow(
      /endpoint not found/
    );
  });

  /**
   * A 404 from this endpoint has two unrelated causes, and they need opposite
   * responses from the Builder. The `ExperimentalFeature` filter in front of
   * the storage controller short-circuits with 404 whenever
   * `FeatureFlags:EnableStorage` is off, which is the default — so a current
   * server answers exactly like an old one, and the old message sent people to
   * upgrade a build that was already fine.
   */
  describe('404 disambiguation', () => {
    /** Body shape of `NotFoundObjectResult("<Feature> is an experimental …")`. */
    function featureDisabled(body: unknown) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve(JSON.stringify(body)),
      };
    }

    /** Runs the apply and returns the rejection, failing if it resolves. */
    async function applyAndCaptureError(): Promise<Error> {
      const caught = await applyStorageConfigToServer(tmpConfigPath).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(caught).toBeInstanceOf(Error);
      return caught as Error;
    }

    it('reports a disabled preview feature instead of blaming the build', async () => {
      fetchMock.mockResolvedValue(
        featureDisabled(
          'Storage is an experimental feature and is not yet available for this workspace.'
        )
      );

      const error = await applyAndCaptureError();

      expect(error.message).toContain('disabled on the server');
      // The server's own wording is surfaced rather than paraphrased.
      expect(error.message).toContain('experimental feature');
      // And the Builder is told the specific knob to turn.
      expect(error.message).toContain('FeatureFlags__EnableStorage=true');
      expect(error.message).not.toMatch(/Upgrade the Rayfin webservice/u);
    });

    it('still blames the build when the route is genuinely absent', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('<html>404</html>'),
      });

      const error = await applyAndCaptureError();

      expect(error.message).toMatch(/Upgrade the Rayfin webservice/u);
      expect(error.message).not.toContain('disabled on the server');
    });

    it('recognises the notice however the server wraps it', async () => {
      // Matching the phrase rather than the exact sentence keeps this working
      // if the server rewords the notice or switches to ProblemDetails.
      for (const body of [
        'Files is an experimental feature and is not yet available.',
        { message: 'Storage is an experimental feature.' },
        { title: 'Storage is an experimental feature.' },
        { error: 'Storage is an experimental feature.' },
      ]) {
        fetchMock.mockResolvedValue(featureDisabled(body));
        const error = await applyAndCaptureError();
        expect(error.message).toContain('disabled on the server');
      }
    });

    it('falls back to the build message when the body cannot be read', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.reject(new Error('stream already consumed')),
      });

      const error = await applyAndCaptureError();

      expect(error.message).toMatch(/Upgrade the Rayfin webservice/u);
    });
  });

  it('keeps 409 guidance actionable when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: () => Promise.resolve('502 Bad Gateway (upstream, not JSON)'),
    });
    await expect(applyStorageConfigToServer(tmpConfigPath)).rejects.toThrow(
      /blocked \(409\)[\s\S]*502 Bad Gateway \(upstream, not JSON\)[\s\S]*--force/
    );
  });

  it('throws on invalid json file', async () => {
    (readFileSync as any).mockReturnValue('{ invalid-json');
    await expect(applyStorageConfigToServer(tmpConfigPath)).rejects.toThrow(
      /Invalid JSON/
    );
  });

  it('throws when folders root missing', async () => {
    (readFileSync as any).mockReturnValue('{}');
    await expect(applyStorageConfigToServer(tmpConfigPath)).rejects.toThrow(
      /folders/
    );
  });

  it('appends force=true when force flag provided', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });
    await applyStorageConfigToServer(tmpConfigPath, undefined, true);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/force=true/);
  });

  it('records response activity when a remote endpoint has no authorization header', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'x-ms-root-activity-id': 'storage-activity-1' },
      })
    );
    const context = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(context);

    await applyStorageConfigToServer(
      tmpConfigPath,
      'https://fabric.example/api/applystorageconfig',
      false,
      true
    );

    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["storage-activity-1"]');
  });
});
