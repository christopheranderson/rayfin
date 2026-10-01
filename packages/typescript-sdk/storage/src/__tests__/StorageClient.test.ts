import type { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createStorageClient } from '../StorageClient';
import { type StorageObjectRef } from '../StorageFolderClient';

const GENERATED_CORRELATION_ID = '00000000-0000-4000-8000-000000000000';

// Mock ApiClient for testing
const createMockApiClient = (): ApiClient =>
  ({
    requestRaw: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    setAccessTokenCallback: vi.fn(),
  }) as any;

// Helper to build mock Response
function buildResponse(
  status: number,
  body: any,
  headers?: Record<string, string>
) {
  const h = new Headers(headers || {});
  const jsonBlob = new Blob([JSON.stringify(body)], {
    type: 'application/json',
  });
  const stream = (jsonBlob as any).stream();
  return new Response(stream, { status, headers: h });
}

// For download we need binary stream
function buildBinaryResponse(
  status: number,
  bytes: Uint8Array,
  headers?: Record<string, string>
) {
  const h = new Headers(headers || {});
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  return new Response(stream as any, { status, headers: h });
}

// Routes a full 3-step SAS upload flow across the multiple requestRaw calls the
// new upload() makes: open session -> poll for SAS -> PUT OneLake -> commit -> poll done.
function installUploadFlow(
  mockApiClient: ApiClient,
  opts?: { signedUrl?: string; correlationId?: string }
) {
  const signedUrl =
    opts?.signedUrl ?? 'https://onelake.example/staging/blob?sas';
  const cid = opts?.correlationId ?? 'cid-op';
  let committed = false;
  (mockApiClient.requestRaw as any).mockImplementation(
    (path: string, init: any) => {
      // Direct-to-OneLake transfer (absolute URL, auth-skipped).
      if (init?.allowProxyPath === false) {
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      if (path === 'api/storage/upload') {
        return Promise.resolve(
          buildResponse(
            202,
            { operationId: 'upload-1', status: 'UploadStarted' },
            { 'X-Correlation-ID': cid }
          )
        );
      }
      if (path.includes('/commit')) {
        committed = true;
        return Promise.resolve(
          buildResponse(202, {
            operationId: 'upload-1',
            status: 'CommittingUpload',
          })
        );
      }
      if (path.includes('/operations/')) {
        return Promise.resolve(
          committed
            ? buildResponse(200, {
                operationId: 'upload-1',
                status: 'Succeeded',
                success: true,
              })
            : buildResponse(200, {
                operationId: 'upload-1',
                status: 'WaitingForUpload',
                signedUrl,
              })
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    }
  );
  return { signedUrl };
}

describe('StorageClient', () => {
  let mockApiClient: ApiClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      GENERATED_CORRELATION_ID
    );
    mockApiClient = createMockApiClient();
  });

  it('upload success returns object & correlation id', async () => {
    installUploadFlow(mockApiClient);

    const storage = createStorageClient<{ photos: StorageObjectRef }>(
      mockApiClient
    );
    const res = await storage.photos.upload('file.txt', 'hello world', {
      contentType: 'text/plain',
      contentDisposition: 'attachment; filename="file.txt"',
      cacheControl: 'public, max-age=3600',
    });

    // Object is synthesized from the request (service does not echo it yet).
    expect(res.object.name).toBe('file.txt');
    expect(res.object.path).toBe('file.txt');
    expect(res.object.size).toBe(11); // inferred from 'hello world'
    expect(res.object.contentDisposition).toBe(
      'attachment; filename="file.txt"'
    );
    expect(res.correlationId).toBe(GENERATED_CORRELATION_ID);

    const calls = (mockApiClient.requestRaw as any).mock.calls;

    // Session opened on the folder-agnostic upload endpoint (folder in body).
    const initCall = calls.find((c: any[]) => c[0] === 'api/storage/upload');
    expect(initCall).toBeTruthy();
    const initBody = JSON.parse(initCall[1].body);
    expect(initBody.folder).toBe('photos');
    expect(initBody.fileName).toBe('file.txt');
    expect(initBody.contentType).toBe('text/plain');
    expect(initBody.contentDisposition).toBe('attachment; filename="file.txt"');
    expect(initBody.cacheControl).toBe('public, max-age=3600');
    expect(initBody.maxBytes).toBe(11);
    expect(initCall[1].headers['X-Correlation-ID']).toBe(
      GENERATED_CORRELATION_ID
    );

    // Bytes went direct to OneLake via an auth-skipped absolute PUT.
    const putCall = calls.find((c: any[]) => c[1]?.allowProxyPath === false);
    expect(putCall[1].method).toBe('PUT');
    expect(putCall[1].skipAuth).toBe(true);
    expect(putCall[1].body).toBe('hello world');
    expect(putCall[1].headers['Content-Type']).toBe('text/plain');
    expect(putCall[1].headers['Content-Disposition']).toBe(
      'attachment; filename="file.txt"'
    );
    expect(putCall[1].headers['Cache-Control']).toBe('public, max-age=3600');

    // Commit was issued for the returned upload id, with no request body
    // (mirrors the server contract: commit takes only the route uploadId).
    const commitCall = calls.find((c: any[]) => c[0].includes('/commit'));
    expect(commitCall).toBeTruthy();
    expect(commitCall[1].body).toBeUndefined();
    expect(commitCall[1].headers['Content-Type']).toBeUndefined();
  });

  it('infers content type only from Blob data', async () => {
    installUploadFlow(mockApiClient);

    const storage = createStorageClient<{ photos: StorageObjectRef }>(
      mockApiClient
    );
    const result = await storage.photos.upload(
      'photo.png',
      new Blob(['image-bytes'], { type: 'image/png' })
    );

    expect(result.object.contentType).toBe('image/png');
    const calls = (mockApiClient.requestRaw as any).mock.calls;
    const initCall = calls.find(
      (call: any[]) => call[0] === 'api/storage/upload'
    );
    expect(JSON.parse(initCall[1].body).contentType).toBe('image/png');
    const putCall = calls.find(
      (call: any[]) => call[1]?.allowProxyPath === false
    );
    expect(putCall[1].headers['Content-Type']).toBe('image/png');
  });

  it('defaults non-Blob upload content to application/octet-stream', async () => {
    installUploadFlow(mockApiClient);

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    const result = await storage.docs.upload('file.txt', 'text');

    expect(result.object.contentType).toBe('application/octet-stream');
    const putCall = (mockApiClient.requestRaw as any).mock.calls.find(
      (call: any[]) => call[1]?.allowProxyPath === false
    );
    expect(putCall[1].headers['Content-Type']).toBe('application/octet-stream');
  });

  it.each([
    ['upload', 'nested/file.txt'],
    ['download', 'nested/file.txt'],
    ['delete', 'nested\\file.txt'],
  ] as const)(
    '%s rejects names containing path separators',
    async (operation, name) => {
      const storage = createStorageClient<{ docs: StorageObjectRef }>(
        mockApiClient
      );

      const request =
        operation === 'upload'
          ? storage.docs.upload(name, 'contents')
          : storage.docs[operation](name);

      await expect(request).rejects.toMatchObject({
        code: 'InvalidName',
        status: 400,
        correlationId: GENERATED_CORRELATION_ID,
        retryable: false,
      });
      expect(mockApiClient.requestRaw).not.toHaveBeenCalled();
    }
  );

  it('includes the upload prefix without synthesizing timestamps', async () => {
    installUploadFlow(mockApiClient);

    const storage = createStorageClient<{ photos: StorageObjectRef }>(
      mockApiClient
    );
    const result = await storage.photos.upload('file.png', 'contents', {
      prefix: 'todos/todo-123',
    });

    expect(result.object.path).toBe('todos/todo-123/file.png');
    expect(result.object).not.toHaveProperty('createdAt');
    expect(result.object).not.toHaveProperty('updatedAt');
  });

  it('upload includes submitted fields in the synthesized object', async () => {
    interface TeamDocument {
      team_id: string;
    }

    installUploadFlow(mockApiClient);
    const storage = createStorageClient<{ docs: TeamDocument }>(mockApiClient);

    const result = await storage.docs.upload('plan.txt', 'contents', {
      fields: { team_id: 'team-42' },
    });

    expect(result.object.team_id).toBe('team-42');
  });

  it('upload maps error response to StorageError', async () => {
    (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
      if (path === 'api/storage/upload') {
        return Promise.resolve(
          buildResponse(
            409,
            {
              error: {
                code: 'Conflict',
                message: 'dup',
                correlationId: 'cid-2',
              },
            },
            { 'X-Correlation-ID': 'cid-2' }
          )
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.upload('a.txt', 'x')).rejects.toMatchObject({
      code: 'Conflict',
      status: 409,
      correlationId: 'cid-2',
      retryable: false,
    });
  });

  it('upload does not expose the OneLake SAS response on transfer failure', async () => {
    (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
      if (path === 'api/storage/upload') {
        return Promise.resolve(
          buildResponse(202, {
            operationId: 'op-transfer-failed',
            status: 'UploadStarted',
          })
        );
      }
      if (path.includes('/operations/')) {
        return Promise.resolve(
          buildResponse(200, {
            operationId: 'op-transfer-failed',
            status: 'Running',
            signedUrl: 'https://onelake.example/upload?sig=secret',
          })
        );
      }
      if (path.startsWith('https://onelake.example/')) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.upload('a.txt', 'x')).rejects.toMatchObject({
      code: 'UploadSessionExpired',
      status: 403,
      correlationId: GENERATED_CORRELATION_ID,
      response: undefined,
    });
  });

  it('upload does not expose a SAS URL from a transport failure', async () => {
    (mockApiClient.requestRaw as any).mockImplementation(
      (path: string, init: any) => {
        if (path === 'api/storage/upload') {
          return Promise.resolve(
            buildResponse(202, {
              operationId: 'op-transport-failed',
              status: 'UploadStarted',
            })
          );
        }
        if (path.includes('/operations/')) {
          return Promise.resolve(
            buildResponse(200, {
              operationId: 'op-transport-failed',
              status: 'Running',
              signedUrl: 'https://onelake.example/upload?sig=secret',
            })
          );
        }
        if (init?.allowProxyPath === false) {
          return Promise.reject(
            new Error(
              'Network error for https://onelake.example/upload?sig=secret'
            )
          );
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
    );

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    const error = await storage.docs
      .upload('a.txt', 'x')
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'StorageError',
      code: 'Unexpected',
      status: 502,
      correlationId: GENERATED_CORRELATION_ID,
      retryable: true,
      response: undefined,
      message: 'Upload transfer request failed.',
    });
    expect((error as Error).message).not.toContain('sig=secret');
  });

  it('upload maps ORCHESTRATION_SYSTEM_ERROR to retryable Unexpected', async () => {
    (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
      if (path === 'api/storage/upload') {
        return Promise.resolve(
          buildResponse(202, { operationId: 'op-sys', status: 'UploadStarted' })
        );
      }
      if (path.includes('/operations/')) {
        return Promise.resolve(
          buildResponse(200, {
            operationId: 'op-sys',
            status: 'Failed',
            success: false,
            errorCode: 'ORCHESTRATION_SYSTEM_ERROR',
            errorMessage: 'backend blipped',
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.upload('a.txt', 'x')).rejects.toMatchObject({
      code: 'Unexpected',
      status: 500,
      retryable: true,
      correlationId: GENERATED_CORRELATION_ID,
      message: 'backend blipped',
    });
  });
  it('upload maps ORCHESTRATION_USER_ERROR to terminal Unexpected', async () => {
    (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
      if (path === 'api/storage/upload') {
        return Promise.resolve(
          buildResponse(202, { operationId: 'op-usr', status: 'UploadStarted' })
        );
      }
      if (path.includes('/operations/')) {
        return Promise.resolve(
          buildResponse(200, {
            operationId: 'op-usr',
            status: 'Failed',
            success: false,
            errorCode: 'ORCHESTRATION_USER_ERROR',
            errorMessage: 'bad input',
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.upload('a.txt', 'x')).rejects.toMatchObject({
      code: 'Unexpected',
      status: 400,
      retryable: false,
      correlationId: GENERATED_CORRELATION_ID,
      message: 'bad input',
    });
  });

  it('upload maps a granular poll error to its SDK code and status', async () => {
    (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
      if (path === 'api/storage/upload') {
        return Promise.resolve(
          buildResponse(202, {
            operationId: 'op-target-exists',
            status: 'UploadStarted',
          })
        );
      }
      if (path.includes('/operations/')) {
        return Promise.resolve(
          buildResponse(200, {
            operationId: 'op-target-exists',
            status: 'Failed',
            success: false,
            errorCode: 'UPLOAD_TARGET_EXISTS',
            errorMessage: 'An object already exists at the target path.',
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.upload('a.txt', 'x')).rejects.toMatchObject({
      code: 'Conflict',
      status: 409,
      retryable: false,
      correlationId: GENERATED_CORRELATION_ID,
      message: 'An object already exists at the target path.',
    });
  });

  it('upload rejects when the operation succeeds without a SAS URL', async () => {
    (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
      if (path === 'api/storage/upload') {
        return Promise.resolve(
          buildResponse(202, {
            operationId: 'op-no-sas',
            status: 'UploadStarted',
          })
        );
      }
      if (path.includes('/operations/')) {
        return Promise.resolve(
          buildResponse(200, {
            operationId: 'op-no-sas',
            status: 'Succeeded',
            success: true,
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.upload('a.txt', 'x')).rejects.toMatchObject({
      code: 'Unexpected',
      status: 502,
      retryable: true,
      correlationId: GENERATED_CORRELATION_ID,
      message: 'Upload session reached a terminal state without a SAS URL.',
    });
  });

  it('upload rejects when polling exceeds the operation deadline', async () => {
    vi.useFakeTimers();
    try {
      (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
        if (path === 'api/storage/upload') {
          return Promise.resolve(
            buildResponse(202, {
              operationId: 'op-stuck',
              status: 'UploadStarted',
            })
          );
        }
        if (path.includes('/operations/')) {
          return Promise.resolve(
            buildResponse(200, {
              operationId: 'op-stuck',
              status: 'Running',
              success: true,
            })
          );
        }
        return Promise.resolve(new Response(null, { status: 500 }));
      });

      const storage = createStorageClient<{ docs: StorageObjectRef }>(
        mockApiClient
      );
      const assertion = expect(
        storage.docs.upload('a.txt', 'x')
      ).rejects.toMatchObject({
        code: 'Unexpected',
        status: 504,
        retryable: true,
        correlationId: GENERATED_CORRELATION_ID,
      });

      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it('download success returns stream, headers & correlation id', async () => {
    const bytes = new TextEncoder().encode('file-bytes');
    (mockApiClient.requestRaw as any).mockImplementation(
      (path: string, init: any) => {
        if (path === 'api/storage/download') {
          return Promise.resolve(
            buildResponse(200, {
              signedUrl: 'https://onelake.example/read?sas',
              expiresAt: '2025-01-01T01:00:00Z',
            })
          );
        }
        if (init?.allowProxyPath === false) {
          return Promise.resolve(
            buildBinaryResponse(200, bytes, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': 'attachment; filename="a.bin"',
              'Content-Length': String(bytes.byteLength),
              ETag: 'etag-1',
            })
          );
        }
        return Promise.resolve(new Response(null, { status: 500 }));
      }
    );

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    const res = await storage.docs.download('a.bin');

    expect(res.correlationId).toBe(GENERATED_CORRELATION_ID);
    expect(res.stream).toBeTruthy();
    expect(res.contentType).toBe('application/octet-stream');
    expect(res.contentDisposition).toBe('attachment; filename="a.bin"');
    expect(res.contentLength).toBe(bytes.byteLength);
    expect(res.etag).toBe('etag-1');

    const calls = (mockApiClient.requestRaw as any).mock.calls;
    // SAS request carried folder + fileName in the body.
    const sasCall = calls.find((c: any[]) => c[0] === 'api/storage/download');
    const sasBody = JSON.parse(sasCall[1].body);
    expect(sasBody.folder).toBe('docs');
    expect(sasBody.fileName).toBe('a.bin');
    const getCall = calls.find((c: any[]) => c[1]?.allowProxyPath === false);
    expect(getCall[1].headers).toBeUndefined();
  });

  it('leaves content disposition undefined when OneLake omits it', async () => {
    (mockApiClient.requestRaw as any)
      .mockResolvedValueOnce(
        buildResponse(200, {
          signedUrl: 'https://onelake.example/read?sas',
        })
      )
      .mockResolvedValueOnce(
        buildBinaryResponse(200, new Uint8Array([1, 2, 3]))
      );

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );

    const result = await storage.docs.download('a.bin');

    expect(result.contentDisposition).toBeUndefined();
  });

  it('download does not expose the OneLake SAS response on failure', async () => {
    (mockApiClient.requestRaw as any)
      .mockResolvedValueOnce(
        buildResponse(200, {
          signedUrl: 'https://onelake.example/read?sig=secret',
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.download('private.bin')).rejects.toMatchObject({
      code: 'Unexpected',
      status: 403,
      correlationId: GENERATED_CORRELATION_ID,
      response: undefined,
    });
  });

  it('download does not expose a SAS URL from a transport failure', async () => {
    (mockApiClient.requestRaw as any)
      .mockResolvedValueOnce(
        buildResponse(200, {
          signedUrl: 'https://onelake.example/read?sig=secret',
        })
      )
      .mockRejectedValueOnce(
        new Error('Network error for https://onelake.example/read?sig=secret')
      );

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    const error = await storage.docs
      .download('private.bin')
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'StorageError',
      code: 'Unexpected',
      status: 502,
      correlationId: GENERATED_CORRELATION_ID,
      retryable: true,
      response: undefined,
      message: 'Download request failed.',
    });
    expect((error as Error).message).not.toContain('sig=secret');
  });

  it('list propagates continuation token', async () => {
    const mockResponse = buildResponse(
      200,
      {
        items: [
          {
            id: 'obj_a',
            folder: 'docs',
            path: 'a.txt',
            name: 'a.txt',
            size: 4,
            createdAt: '2025-01-01T00:00:00Z',
          },
        ],
        continuation: 'next123',
      },
      { 'X-Correlation-ID': 'cid-list' }
    );

    (mockApiClient.requestRaw as any).mockResolvedValueOnce(mockResponse);

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    const res = await storage.docs.list({
      prefix: 'reports/2026',
      limit: 1,
      continuation: 'prev',
    });

    expect(res.items.length).toBe(1);
    expect(res.continuation).toBe('next123');
    expect(res.correlationId).toBe(GENERATED_CORRELATION_ID);

    expect(mockApiClient.requestRaw).toHaveBeenCalledWith(
      expect.stringContaining('api/storage/list'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-Correlation-ID': GENERATED_CORRELATION_ID,
        }),
      })
    );

    // Verify the folder + query parameters are present (order doesn't matter)
    const callArgs = (mockApiClient.requestRaw as any).mock.calls[0];
    const requestPath = callArgs[0];
    expect(requestPath).toContain('folder=docs');
    expect(requestPath).toContain('prefix=reports%2F2026');
    expect(requestPath).toContain('limit=1');
    expect(requestPath).toContain('continuation=prev');
  });

  it('list flattens fields returned by the service', async () => {
    const items = [
      {
        id: 'obj_a',
        folder: 'docs',
        path: 'a.txt',
        name: 'a.txt',
        size: 4,
        fields: { team_id: 'team-42' },
      },
      {
        id: 'obj_b',
        folder: 'docs',
        path: 'b.txt',
        name: 'b.txt',
        size: 5,
        fields: { transcription: 'Notes' },
      },
    ];
    (mockApiClient.requestRaw as any).mockResolvedValueOnce(
      buildResponse(200, { items })
    );

    interface DocumentFields {
      team_id: string;
      transcription: string;
    }
    const storage = createStorageClient<{ docs: DocumentFields }>(
      mockApiClient
    );
    const result = await storage.docs.list();

    expect(result.items[0].team_id).toBe('team-42');
    expect(result.items[0]).not.toHaveProperty('fields');
    expect(result.items[1].transcription).toBe('Notes');
    expect(result.items[1]).not.toHaveProperty('fields');
  });

  it('abort upload yields Aborted error code', async () => {
    const abortError = new Error('Request aborted');
    abortError.name = 'AbortError';

    (mockApiClient.requestRaw as any).mockRejectedValueOnce(abortError);

    const storage = createStorageClient<{ photos: StorageObjectRef }>(
      mockApiClient
    );
    const ac = new AbortController();
    const p = storage.photos.upload('willAbort.bin', 'data', {
      signal: ac.signal,
    });

    // Simulate abort after starting request
    setTimeout(() => ac.abort(), 1);

    await expect(p).rejects.toMatchObject({ code: 'Aborted' });
  });

  it('non-json error still maps to Unexpected', async () => {
    const mockResponse = new Response('plain failure', {
      status: 500,
      headers: { 'X-Correlation-ID': 'cid-e' },
    });
    Object.defineProperty(mockResponse, 'ok', { value: false });

    (mockApiClient.requestRaw as any).mockResolvedValueOnce(mockResponse);

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.delete('x.txt')).rejects.toMatchObject({
      code: 'Unexpected',
      status: 500,
      correlationId: 'cid-e',
    });
  });

  it('delete starts async op, polls to Succeeded, returns success', async () => {
    const cid = GENERATED_CORRELATION_ID;
    (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
      if (path.includes('/operations/')) {
        return Promise.resolve(
          buildResponse(200, {
            operationId: 'delete-1',
            status: 'Succeeded',
            success: true,
          })
        );
      }
      // Initial DELETE api/storage/delete (folder in the body).
      return Promise.resolve(
        buildResponse(
          202,
          { operationId: 'delete-1', status: 'DeleteStarted' },
          { 'X-Correlation-ID': cid }
        )
      );
    });

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    const res = await storage.docs.delete('x.txt');

    expect(res.success).toBe(true);
    expect(res.deleted).toBe(1);
    expect(res.correlationId).toBe(cid);

    const calls = (mockApiClient.requestRaw as any).mock.calls;

    // The start leg is a DELETE against the folder-agnostic delete endpoint,
    // carrying the folder + object name in the JSON body (not the path).
    const startCall = calls.find(
      (c: any[]) => c[0] === 'api/storage/delete' && c[1]?.method === 'DELETE'
    );
    expect(startCall).toBeTruthy();
    expect(startCall[1].headers['X-Correlation-ID']).toBe(cid);
    const startBody = JSON.parse(startCall[1].body);
    expect(startBody.folder).toBe('docs');
    expect(startBody.fileName).toBe('x.txt');

    // The terminal status was polled on the shared operations endpoint.
    const pollCall = calls.find((c: any[]) => c[0].includes('/operations/'));
    expect(pollCall).toBeTruthy();
    expect(pollCall[1]).toMatchObject({
      method: 'GET',
      headers: { 'X-Correlation-ID': cid },
    });
  });

  it('delete sends folder, fileName and prefix in the request body', async () => {
    (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
      if (path.includes('/operations/')) {
        return Promise.resolve(
          buildResponse(200, {
            operationId: 'delete-2',
            status: 'Succeeded',
            success: true,
          })
        );
      }
      return Promise.resolve(
        buildResponse(202, { operationId: 'delete-2', status: 'DeleteStarted' })
      );
    });

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await storage.docs.delete('photo.png', { prefix: 'nested/dir' });

    const calls = (mockApiClient.requestRaw as any).mock.calls;
    const startCall = calls.find(
      (c: any[]) => c[0] === 'api/storage/delete' && c[1]?.method === 'DELETE'
    );
    expect(startCall).toBeTruthy();
    const body = JSON.parse(startCall[1].body);
    expect(body).toMatchObject({
      folder: 'docs',
      fileName: 'photo.png',
      prefix: 'nested/dir',
    });
  });

  it('delete surfaces a StorageError when the operation reports failure', async () => {
    (mockApiClient.requestRaw as any).mockImplementation((path: string) => {
      if (path.includes('/operations/')) {
        return Promise.resolve(
          buildResponse(200, {
            operationId: 'delete-3',
            status: 'Failed',
            success: false,
            errorCode: 'ORCHESTRATION_USER_ERROR',
            errorMessage: 'Not permitted.',
          })
        );
      }
      return Promise.resolve(
        buildResponse(202, { operationId: 'delete-3', status: 'DeleteStarted' })
      );
    });

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.delete('x.txt')).rejects.toMatchObject({
      name: 'StorageError',
      code: 'Unexpected',
      status: 400,
      retryable: false,
      correlationId: GENERATED_CORRELATION_ID,
      message: 'Not permitted.',
    });
  });

  it('keeps the internal move implementation ready for service support', async () => {
    const mockResponse = buildResponse(
      200,
      {
        object: {
          id: 'obj_03',
          folder: 'docs',
          path: 'archive/a.txt',
          name: 'a.txt',
          size: 4,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-03T00:00:00Z',
        },
      },
      { 'X-Correlation-ID': 'cid-mv' }
    );
    (mockApiClient.requestRaw as any).mockResolvedValueOnce(mockResponse);

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    // @ts-expect-error Move remains private until the service endpoint exists.
    const res = await storage.docs.move('a.txt', 'archive/a.txt');

    expect(res.object.path).toBe('archive/a.txt');
    expect(res.correlationId).toBe('cid-mv');

    const [callPath, callInit] = (mockApiClient.requestRaw as any).mock
      .calls[0];
    expect(callPath).toContain('api/storage/docs/a.txt');
    expect(callPath).toContain('op=move');
    expect(callPath).toContain('dest=archive%2Fa.txt');
    expect(callInit.method).toBe('POST');
  });

  it('download throws Unexpected when the response has no body stream', async () => {
    (mockApiClient.requestRaw as any)
      .mockResolvedValueOnce(
        buildResponse(200, {
          signedUrl: 'https://onelake.example/empty.bin?sas',
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'X-Correlation-ID': 'cid-nb' },
        })
      );

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(storage.docs.download('empty.bin')).rejects.toMatchObject({
      code: 'Unexpected',
      status: 200,
      response: undefined,
    });
  });

  it('maps internal move failures for future service support', async () => {
    const mockResponse = buildResponse(
      409,
      {
        error: {
          code: 'Conflict',
          message: 'destination already exists',
          correlationId: 'cid-mv-err',
        },
      },
      { 'X-Correlation-ID': 'cid-mv-err' }
    );
    (mockApiClient.requestRaw as any).mockResolvedValueOnce(mockResponse);

    const storage = createStorageClient<{ docs: StorageObjectRef }>(
      mockApiClient
    );
    await expect(
      // @ts-expect-error Move remains private until the service endpoint exists.
      storage.docs.move('a.txt', 'b.txt')
    ).rejects.toMatchObject({
      code: 'Conflict',
      status: 409,
      correlationId: 'cid-mv-err',
    });
  });
});
