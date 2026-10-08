import type { StorageObject } from '@microsoft/rayfin-core/experimental';
import { SdkError } from '@microsoft/rayfin-lib';
import type { ApiClient } from '@microsoft/rayfin-lib';

import {
  isRetryableStorageError,
  mapOperationErrorCode,
  type StorageErrorCode,
} from './storageErrorCodes';

/** Public shape of an error returned by storage operations */
export interface StorageError extends Error {
  code: StorageErrorCode;
  status: number;
  correlationId: string;
  /** Present only when the underlying transport returned a Response. */
  response?: Response;
  /**
   * Indicates whether the caller may retry by invoking the same public SDK
   * operation again from the beginning.
   *
   * For multi-step operations such as upload and delete, retrying creates a new
   * server orchestration. The SDK does not resume a failed orchestration or retry
   * only an internal phase such as transfer, commit, or polling.
   *
   * This value is a recommendation only. The SDK does not retry automatically.
   */
  retryable: boolean;
}

/**
 * Object metadata returned from the storage service.
 *
 * `path` is the caller-facing object path persisted by the service.
 */
export interface StorageObjectRef {
  /** Stable object identifier (server-assigned). */
  id: string;
  /** Folder name (logical, post-normalization). */
  folder: string;
  /**
   * The object path, including the caller-provided prefix when present.
   */
  path: string;
  /** File name component of `path` (basename). */
  name: string;
  /**
   * Size in bytes. Capped to `Number.MAX_SAFE_INTEGER`; use `sizeBig` for
   * objects larger than ~8 PB.
   */
  size: number;
  /** Exact size for objects larger than `Number.MAX_SAFE_INTEGER` bytes. */
  sizeBig?: bigint;
  /** MIME type as declared on upload (server-validated). */
  contentType?: string;
  /** Content-Disposition value declared on upload. */
  contentDisposition?: string;
  /** Cache-Control value declared on upload. */
  cacheControl?: string;
  /** ISO 8601 creation timestamp, when supplied by the service. */
  createdAt?: string;
  /** ISO 8601 last-modified timestamp, when supplied by the service. */
  updatedAt?: string;
  /** ISO 8601 timestamp of last read, when tracked by the service. */
  lastAccessedAt?: string | null;
  /** ETag for optimistic concurrency. */
  etag?: string;
}

/**
 * Extracts app-specific fields from a storage object type by omitting the
 * built-in object and storage metadata fields.
 *
 * @typeParam TObject - The storage object type containing custom fields.
 */
export type StorageCustomFields<TObject> = Omit<
  TObject,
  keyof StorageObjectRef | keyof StorageObject
>;

export interface StorageUploadResult<TObject = StorageObjectRef> {
  object: TObject;
  correlationId: string;
}
export interface StorageDownloadResult {
  stream: ReadableStream<Uint8Array>;
  /** MIME type reported by OneLake for the downloaded object. */
  contentType?: string;
  /** Content-Disposition reported by OneLake for the downloaded object. */
  contentDisposition?: string;
  /** Object size in bytes, from the OneLake `Content-Length` header when present. */
  contentLength?: number;
  /** ETag of the downloaded object. */
  etag?: string;
  correlationId: string;
}
export interface StorageDeleteResult {
  success: boolean;
  deleted: number;
  correlationId: string;
}
export interface StorageListResult<TObject = StorageObjectRef> {
  items: TObject[];
  continuation?: string;
  correlationId: string;
}
interface StorageMoveResult<TObject = StorageObjectRef> {
  object: TObject;
  correlationId: string;
}

export interface UploadOptions<
  TObject extends StorageObjectRef = StorageObjectRef,
> {
  prefix?: string;
  signal?: AbortSignal;
  /** Overrides the MIME type inferred from Blob data. */
  contentType?: string;
  /** Content-Disposition value persisted as metadata and sent to OneLake. */
  contentDisposition?: string;
  /** Cache-Control header value persisted on the object and sent to OneLake. */
  cacheControl?: string;
  /**
   * SAS lifetime requested for the upload URL, in seconds. Server-clamped to
   * its allowed range (60–3600). When omitted the service default applies.
   */
  expiresInSeconds?: number;
  /**
   * App-specific typed fields declared on the `@blob` class (e.g. `team_id`).
   * Type-checked against the folder's `@blob` schema. Use this for anything a
   * policy predicate needs to compare.
   */
  fields?: Partial<StorageCustomFields<TObject>>;
}
export interface DownloadOptions {
  prefix?: string;
  signal?: AbortSignal;
  /** SAS lifetime requested for the download URL, in seconds (server-clamped). */
  expiresInSeconds?: number;
}
export interface DeleteOptions {
  prefix?: string;
  signal?: AbortSignal;
}
export interface ListOptions {
  prefix?: string;
  limit?: number;
  continuation?: string;
  signal?: AbortSignal;
}
interface MoveOptions {
  signal?: AbortSignal;
}

interface InternalErrorShape {
  error?: { code?: string; message?: string; correlationId?: string };
}

/** 202 body from POST api/storage/upload and api/storage/uploads/\{id\}/commit. */
interface OperationStartBody {
  operationId: string;
  status: string;
}

/** Body from GET api/storage/operations/\{id\}/status (upload subtype adds SAS fields). */
interface OperationPollBody {
  operationId: string;
  status: string;
  success?: boolean;
  /**
   * Service error code for a terminal operation failure. Activities transport
   * granular uppercase codes when available. Older or unclassified failures use
   * `ORCHESTRATION_USER_ERROR` or `ORCHESTRATION_SYSTEM_ERROR`.
   */
  errorCode?: string;
  errorMessage?: string;
  signedUrl?: string;
  sasExpiresAt?: string;
}

/** Body from POST api/storage/download (SasUrlResult). */
interface SasUrlBody {
  signedUrl: string;
  expiresAt?: string;
}

interface StorageListWireItem extends StorageObjectRef {
  fields?: unknown;
}

/** Terminal + intermediate orchestration statuses exposed by the service. */
const UPLOAD_STATUS_SUCCEEDED = 'Succeeded';
const UPLOAD_STATUS_FAILED = 'Failed';
/** How often to poll operation status while awaiting SAS / commit completion. */
const OPERATION_POLL_INTERVAL_MS = 500;
/** Maximum delay between operation status requests. */
const OPERATION_POLL_MAX_INTERVAL_MS = 5_000;
/** Maximum total time spent waiting for an operation to reach the expected state. */
const OPERATION_POLL_DEADLINE_MS = 120_000;

// === CLASS-BASED FOLDER CLIENT (Parity with GraphQLEntityClient style) ===

export class StorageFolderClient<
  TObject extends StorageObjectRef = StorageObjectRef,
> {
  private folderName: string;
  constructor(
    private apiClient: ApiClient,
    folderName: string
  ) {
    this.folderName = folderName;
  }

  // === PUBLIC OPERATIONS ===

  /**
   * Upload an object using the SAS data-plane flow implemented by
   * `StorageSasController` (workloads-appdev). Bytes go **directly to OneLake**;
   * the Rayfin service only brokers the session and commits metadata:
   *
   *   1. POST api/storage/upload                       -\> 202 \{ operationId \}
   *   2. poll GET api/storage/operations/\{id\}/status   -\> until \{ signedUrl \}
   *   3. PUT  \{signedUrl\}                            -\> data direct to OneLake
   *   4. POST api/storage/uploads/\{id\}/commit (no body)  -\> 202, then poll to Succeeded
   *
   * A single `correlationId` is threaded across every leg for traceability.
   *
   * NOTE: the service does not yet echo the committed `StorageObjectRef`
   * (commit/poll return only operation status), so the returned `object` is
   * synthesized from the request.
   *
   * If this method rejects with a retryable `StorageError`, the caller may
   * invoke `upload()` again. The retry starts a new upload session, transfers
   * the content again, and runs a new commit orchestration. The previous
   * orchestration is not resumed.
   */
  async upload(
    name: string,
    data: Blob | ArrayBuffer | Uint8Array | ReadableStream | string,
    options?: UploadOptions<TObject>
  ): Promise<StorageUploadResult<TObject>> {
    const opts = options || {};
    const cid = this.generateCorrelationId();
    this.validateName(name, cid);
    const body = this.toBody(data);
    const inferredSize = this.inferSize(data);
    const contentType = this.resolveContentType(data, opts.contentType);

    // Phase 1: open an upload session and wait for the SAS URL.
    const startResp = await this.serviceCall(
      'POST',
      'upload',
      {
        folder: this.folderName,
        fileName: name,
        prefix: opts.prefix,
        contentType,
        contentDisposition: opts.contentDisposition,
        cacheControl: opts.cacheControl,
        expiresInSeconds: opts.expiresInSeconds,
        maxBytes: inferredSize,
        fields: opts.fields,
      },
      cid,
      opts.signal
    );
    const start = (await startResp.json()) as OperationStartBody;
    const uploadId = start.operationId;

    const sas = await this.pollOperation(uploadId, cid, opts.signal, 'sas');
    if (!sas.signedUrl) {
      throw this.buildError(
        'Unexpected',
        502,
        'Upload session did not yield a SAS URL.',
        cid
      );
    }

    // Phase 2: transfer bytes straight to OneLake (best-effort cleanup on failure).
    try {
      await this.sasTransfer(
        'PUT',
        sas.signedUrl,
        body,
        contentType,
        opts.contentDisposition,
        opts.cacheControl,
        opts.signal,
        cid
      );
    } catch (err) {
      await this.tryAbortUpload(uploadId, cid);
      throw err;
    }
    // Phase 3: commit and wait for the service to persist the object row.
    // The commit endpoint (POST uploads/{id}/commit) carries no body: it only
    // raises the UploadCompleted event to resume the orchestration. All metadata
    // (contentType, contentDisposition, cacheControl, fields) was
    // already captured at the /upload init step, so we send nothing here.
    await this.serviceCall(
      'POST',
      `uploads/${encodeURIComponent(uploadId)}/commit`,
      undefined,
      cid,
      opts.signal
    );
    await this.pollOperation(uploadId, cid, opts.signal, 'done');

    return {
      object: this.synthesizeObject(name, opts, inferredSize, contentType),
      correlationId: cid,
    };
  }

  /**
   * Download the object. Fetches a short-lived read SAS from the Rayfin service
   * (`POST api/storage/download` -\> `\{ signedUrl \}`) then streams the bytes
   * directly from OneLake. Authorization is enforced by the service before the
   * SAS is issued.
   */
  async download(
    name: string,
    options?: DownloadOptions
  ): Promise<StorageDownloadResult> {
    const opts = options || {};
    const cid = this.generateCorrelationId();
    this.validateName(name, cid);

    const sasResp = await this.serviceCall(
      'POST',
      'download',
      {
        folder: this.folderName,
        fileName: name,
        prefix: opts.prefix,
        expiresInSeconds: opts.expiresInSeconds,
      },
      cid,
      opts.signal
    );
    const sas = (await sasResp.json()) as SasUrlBody;
    if (!sas.signedUrl) {
      throw this.buildError(
        'Unexpected',
        502,
        'Download did not yield a SAS URL.',
        cid
      );
    }

    let response: Response;
    try {
      response = await this.apiClient.requestRaw(sas.signedUrl, {
        method: 'GET',
        signal: opts.signal,
        allowProxyPath: false,
        skipAuth: true,
      });
    } catch (error: any) {
      if (this.isAbort(error)) {
        throw this.buildError('Aborted', 499, 'Download aborted', cid);
      }
      throw this.buildError('Unexpected', 502, 'Download request failed.', cid);
    }

    if (!response.ok) {
      throw this.buildError(
        response.status === 404 ? 'NotFound' : 'Unexpected',
        response.status,
        `Download from storage failed (${response.status}).`,
        cid
      );
    }
    if (!response.body) {
      throw this.buildError(
        'Unexpected',
        response.status,
        'Download response did not include a readable body stream.',
        cid
      );
    }

    const contentLength = response.headers.get('Content-Length');
    return {
      stream: response.body,
      contentType: response.headers.get('Content-Type') ?? undefined,
      contentDisposition:
        response.headers.get('Content-Disposition') ?? undefined,
      contentLength: contentLength ? Number(contentLength) : undefined,
      etag: response.headers.get('ETag') ?? undefined,
      correlationId: cid,
    };
  }

  /**
   * Hard-deletes the object. Async, poll-based flow mirroring `upload`.
   *
   * First leg issues `DELETE api/storage/delete` carrying the folder, object name
   * and optional prefix in the JSON body (data-plane contract, mirroring
   * upload/download), and receives a `202` with an operationId. Second leg polls
   * `api/storage/operations/{id}/status` until the orchestration reports a
   * terminal Succeeded or Failed.
   *
   * The service orchestrates the delete durably (claim, authorize, tombstone,
   * delete the blob in OneLake, then delete the row); the SDK waits for the
   * terminal status and surfaces failures as a `StorageError`. A single
   * `correlationId` is threaded across both legs.
   *
   * If this method rejects with a retryable `StorageError`, the caller may
   * invoke `delete()` again. The retry starts a new delete orchestration; the
   * previous orchestration is not resumed.
   */
  async delete(
    name: string,
    options?: DeleteOptions
  ): Promise<StorageDeleteResult> {
    const { prefix, signal } = options || {};
    const cid = this.generateCorrelationId();
    this.validateName(name, cid);

    // Phase 1: start the async hard-delete orchestration (folder in the body).
    const startResp = await this.serviceCall(
      'DELETE',
      'delete',
      {
        folder: this.folderName,
        fileName: name,
        prefix,
      },
      cid,
      signal
    );
    const start = (await startResp.json()) as OperationStartBody;

    // Phase 2: poll until the orchestration reaches a terminal success
    // (throws a StorageError if it reports failure).
    await this.pollOperation(start.operationId, cid, signal, 'done');

    return { success: true, deleted: 1, correlationId: cid };
  }

  /**
   * Reserved for the future storage data-plane move endpoint. Keep this private
   * until the service implements move; the legacy path-based route used below
   * is not part of the deployed storage contract.
   */
  // @ts-expect-error TS6133: Retained for the future data-plane move endpoint.
  private async move(
    srcPath: string,
    destPath: string,
    options?: MoveOptions
  ): Promise<StorageMoveResult> {
    const { signal } = options || {};
    const response = await this.request(
      'POST',
      srcPath,
      { op: 'move', dest: destPath },
      {
        signal,
      }
    );
    const cid = this.getCorrelationId(response);
    const json = await response.json();
    return { object: json.object as StorageObjectRef, correlationId: cid };
  }

  async list(options?: ListOptions): Promise<StorageListResult<TObject>> {
    const { prefix, continuation, limit, signal } = options || {};
    const cid = this.generateCorrelationId();

    // Data-plane GET: the folder travels as a query parameter under the uniform
    // `/list` subpath (mirrors upload/download/delete living under `/{verb}`),
    // while staying a real GET with no body. `encodeQuery` (URLSearchParams)
    // percent-encodes every value, so folder/prefix are passed raw here.
    const query = this.encodeQuery({
      folder: this.folderName,
      prefix,
      continuation,
      limit,
    });
    const response = await this.serviceCall(
      'GET',
      `list${query}`,
      undefined,
      cid,
      signal
    );
    const json = await response.json();
    return {
      items: (json.items as StorageListWireItem[]).map((item) =>
        this.flattenListItem(item)
      ),
      continuation: json.continuation,
      correlationId: cid,
    };
  }

  // === PRIVATE HELPERS ===

  private async request(
    method: string,
    objectName: string,
    query: Record<string, any>,
    options: {
      body?: BodyInit | null;
      signal?: AbortSignal;
      correlationId?: string;
      contentType?: string;
    }
  ): Promise<Response> {
    const { body, signal, correlationId, contentType } = options;

    // Build path and query string
    const basePath = `api/storage/${encodeURIComponent(this.folderName)}`;
    const path = objectName
      ? `${basePath}/${encodeURIComponent(objectName)}`
      : basePath;
    const queryString = this.encodeQuery(query);
    const fullPath = `${path}${queryString}`;

    // Build headers
    const headers: Record<string, string> = {
      'X-Correlation-ID': correlationId ?? this.generateCorrelationId(),
    };
    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    // Early abort check
    if (signal?.aborted) {
      throw this.buildError(
        'Aborted',
        499,
        'Request aborted before sending',
        headers['X-Correlation-ID']
      );
    }

    try {
      const response = await this.apiClient.requestRaw(fullPath, {
        method,
        headers,
        body,
        signal,
      });

      if (!response.ok) {
        await this.handleErrorResponse(response, headers['X-Correlation-ID']);
      }

      return response;
    } catch (error: any) {
      if (
        error.name === 'AbortError' ||
        (error instanceof Error && error.message.includes('abort'))
      ) {
        throw this.buildError(
          'Aborted',
          499,
          `${method} aborted`,
          headers['X-Correlation-ID']
        );
      }
      throw error;
    }
  }

  private async handleErrorResponse(
    response: Response,
    fallbackCorrelationId: string
  ): Promise<never> {
    let parsed: InternalErrorShape | undefined;
    try {
      parsed = await response.json();
    } catch {
      // Failed to parse JSON response, will use default error message
    }

    const code = parsed?.error?.code || 'Unexpected';
    const msg = parsed?.error?.message || `HTTP ${response.status}`;
    const correlationId =
      parsed?.error?.correlationId ||
      this.getCorrelationId(response) ||
      fallbackCorrelationId;

    throw this.buildError(
      code as StorageErrorCode,
      response.status,
      msg,
      correlationId,
      response
    );
  }

  private getCorrelationId(response: Response): string {
    return (
      response.headers.get('X-Correlation-ID') || this.generateCorrelationId()
    );
  }

  private buildError(
    code: StorageErrorCode,
    status: number,
    message: string,
    correlationId: string,
    response?: Response
  ): StorageError {
    const err: StorageError = Object.assign(new Error(message), {
      code,
      status,
      correlationId,
      response,
      retryable: isRetryableStorageError(code, status),
    });
    err.name = 'StorageError';
    return err;
  }

  // === SAS DATA-PLANE HELPERS ===

  /**
   * Calls a folder-agnostic storage service endpoint (`api/storage/{subPath}`)
   * with an optional JSON body, applying correlation + error handling. Used by
   * the SAS upload/download flow, where the folder travels in the body rather
   * than the path (mirrors `StorageSasController`).
   */
  private async serviceCall(
    method: string,
    subPath: string,
    jsonBody: Record<string, unknown> | undefined,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'X-Correlation-ID': correlationId,
    };
    let body: BodyInit | undefined;
    if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      // JSON.stringify drops `undefined` members, so optional fields are omitted.
      body = JSON.stringify(jsonBody);
    }

    this.throwIfAborted(signal, correlationId);

    try {
      const response = await this.apiClient.requestRaw(
        `api/storage/${subPath}`,
        {
          method,
          headers,
          body,
          signal,
        }
      );
      if (!response.ok) {
        await this.handleErrorResponse(response, correlationId);
      }
      return response;
    } catch (error: any) {
      if (this.isAbort(error)) {
        throw this.buildError(
          'Aborted',
          499,
          `${method} aborted`,
          correlationId
        );
      }
      throw error;
    }
  }

  /**
   * Polls operation status until the SAS URL is available (`want: 'sas'`) or the
   * operation reaches a terminal success (`want: 'done'`). Throws a
   * `StorageError` when the orchestration reports failure.
   */
  private async pollOperation(
    operationId: string,
    correlationId: string,
    signal: AbortSignal | undefined,
    want: 'sas' | 'done'
  ): Promise<OperationPollBody> {
    const deadline = Date.now() + OPERATION_POLL_DEADLINE_MS;
    let interval = OPERATION_POLL_INTERVAL_MS;

    for (;;) {
      this.throwIfAborted(signal, correlationId);

      const response = await this.serviceCall(
        'GET',
        `operations/${encodeURIComponent(operationId)}/status`,
        undefined,
        correlationId,
        signal
      );
      const body = (await response.json()) as OperationPollBody;

      if (body.status === UPLOAD_STATUS_FAILED || body.success === false) {
        // Map the service's granular activity errors and coarse orchestration
        // fallbacks to stable SDK codes and representative failure statuses.
        const { code, status } = mapOperationErrorCode(body.errorCode);
        throw this.buildError(
          code,
          status,
          body.errorMessage || 'Storage operation failed.',
          correlationId
        );
      }

      if (want === 'sas' && body.signedUrl) {
        return body;
      }
      if (want === 'done' && body.status === UPLOAD_STATUS_SUCCEEDED) {
        return body;
      }

      if (want === 'sas' && body.status === UPLOAD_STATUS_SUCCEEDED) {
        throw this.buildError(
          'Unexpected',
          502,
          'Upload session reached a terminal state without a SAS URL.',
          correlationId
        );
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw this.buildError(
          'Unexpected',
          504,
          `Storage operation did not reach the expected state within ${OPERATION_POLL_DEADLINE_MS}ms.`,
          correlationId
        );
      }

      await this.delay(Math.min(interval, remainingMs), signal, correlationId);
      interval = Math.min(interval * 2, OPERATION_POLL_MAX_INTERVAL_MS);
    }
  }

  /** Streams bytes directly to (or from) a OneLake SAS URL, bypassing Rayfin auth. */
  private async sasTransfer(
    method: string,
    sasUrl: string,
    body: BodyInit,
    contentType: string | undefined,
    contentDisposition: string | undefined,
    cacheControl: string | undefined,
    signal: AbortSignal | undefined,
    correlationId: string
  ): Promise<Response> {
    const headers: Record<string, string> = { 'x-ms-blob-type': 'BlockBlob' };
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    if (contentDisposition) {
      headers['Content-Disposition'] = contentDisposition;
    }
    if (cacheControl) {
      headers['Cache-Control'] = cacheControl;
    }

    this.throwIfAborted(signal, correlationId);

    let response: Response;
    try {
      response = await this.apiClient.requestRaw(sasUrl, {
        method,
        headers,
        body,
        signal,
        allowProxyPath: false,
        skipAuth: true,
      });
    } catch (error: any) {
      if (this.isAbort(error)) {
        throw this.buildError(
          'Aborted',
          499,
          'Upload aborted during transfer',
          correlationId
        );
      }
      throw this.buildError(
        'Unexpected',
        502,
        'Upload transfer request failed.',
        correlationId
      );
    }

    if (!response.ok) {
      // 403 from the blob endpoint almost always means the SAS lease expired.
      throw this.buildError(
        response.status === 403 ? 'UploadSessionExpired' : 'Unexpected',
        response.status,
        `Direct transfer to storage failed (${response.status}).`,
        correlationId
      );
    }
    return response;
  }

  /** Best-effort cleanup of a staged upload after a transfer failure or abort (RFC §3.5). */
  private async tryAbortUpload(
    uploadId: string,
    correlationId: string
  ): Promise<void> {
    try {
      await this.apiClient.requestRaw(
        `api/storage/uploads/${encodeURIComponent(uploadId)}`,
        { method: 'DELETE', headers: { 'X-Correlation-ID': correlationId } }
      );
    } catch {
      // Cleanup is best-effort; the staging path is reclaimed by the service TTL.
    }
  }

  private synthesizeObject(
    name: string,
    options: UploadOptions<TObject>,
    size: number | undefined,
    contentType: string
  ): TObject {
    const basename = name.split('/').pop() || name;
    const logicalPath = options.prefix ? `${options.prefix}/${name}` : name;
    return {
      id: '',
      folder: this.folderName,
      path: logicalPath,
      name: basename,
      size: size ?? 0,
      contentType,
      contentDisposition: options.contentDisposition,
      cacheControl: options.cacheControl,
      ...options.fields,
    } as TObject;
  }

  private flattenListItem(item: StorageListWireItem): TObject {
    const { fields: wireFields, ...object } = item;
    const fields =
      wireFields !== null &&
      typeof wireFields === 'object' &&
      !Array.isArray(wireFields)
        ? (wireFields as Record<string, unknown>)
        : {};

    return { ...fields, ...object } as TObject;
  }

  private resolveContentType(
    data: Blob | ArrayBuffer | Uint8Array | ReadableStream | string,
    explicitContentType: string | undefined
  ): string {
    if (explicitContentType) {
      return explicitContentType;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob && data.type) {
      return data.type;
    }
    return 'application/octet-stream';
  }

  private inferSize(
    data: Blob | ArrayBuffer | Uint8Array | ReadableStream | string
  ): number | undefined {
    if (typeof data === 'string') {
      return new TextEncoder().encode(data).byteLength;
    }
    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }
    if (data instanceof Uint8Array) {
      return data.byteLength;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return data.size;
    }
    return undefined; // ReadableStream: size unknown up front.
  }

  private validateName(name: string, correlationId: string): void {
    if (name.includes('/') || name.includes('\\')) {
      throw this.buildError(
        'InvalidName',
        400,
        'Object name must be a file name without path separators. Use prefix for directory segments.',
        correlationId
      );
    }
  }

  private throwIfAborted(
    signal: AbortSignal | undefined,
    correlationId: string
  ): void {
    if (signal?.aborted) {
      throw this.buildError('Aborted', 499, 'Request aborted', correlationId);
    }
  }

  private isAbort(error: any): boolean {
    return (
      error?.name === 'AbortError' ||
      (error instanceof Error && error.message.toLowerCase().includes('abort'))
    );
  }

  private delay(
    ms: number,
    signal: AbortSignal | undefined,
    correlationId: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          this.buildError(
            'Aborted',
            499,
            'Aborted while polling',
            correlationId
          )
        );
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(
          this.buildError(
            'Aborted',
            499,
            'Aborted while polling',
            correlationId
          )
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private toBody(
    data: Blob | ArrayBuffer | Uint8Array | ReadableStream | string
  ): BodyInit {
    // If caller provided a ReadableStream explicitly, forward it
    if (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream)
      return data as unknown as BodyInit;

    // Prefer native body types directly to avoid converting to ReadableStream
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return data as unknown as BodyInit;
    if (data instanceof Uint8Array) return data as unknown as BodyInit;

    throw new SdkError('Unsupported upload data type');
  }

  private encodeQuery(
    params: Record<string, string | number | undefined | null>
  ): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private generateCorrelationId(): string {
    return (
      globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
    );
  }
}

// Backwards-compatible exported type alias (old code treated StorageFolderClient as interface)
export type { StorageFolderClient as StorageFolderClientType };

// Re-export error utilities for convenience
export {
  STORAGE_ERROR_CODES,
  type StorageErrorCode,
  isStorageError,
} from './storageErrorCodes';
