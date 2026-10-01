/**
 * Storage error codes.
 *
 * Aligned with the RFC §3.2 `STORAGE_ERROR_CODES` surface so the SDK can map
 * every service/data-plane failure to a stable, switchable `code`. The list is
 * a superset of the RFC set: `InvalidPrefix` is retained for back-compat with
 * the pre-SAS client that surfaced it.
 */
export const STORAGE_ERROR_CODES = [
  'InvalidFolder',
  'InvalidPath',
  'InvalidName',
  'InvalidPrefix',
  'InvalidSasExpiry', // SAS expiry is invalid, should be between 60-3600sec
  'TooLarge',
  'UnsupportedContentType', // content_type not in folder's allowedContentTypes (§0.6)
  'Conflict', // onConflict='error' & object exists
  'NotFound',
  'PermissionDenied', // rule predicate evaluated false
  'Unauthenticated',
  'InvalidContinuation',
  'UploadSessionExpired', // SAS/upload session expired before commit
  'CommitFailed', // OneLake HEAD/size/etag mismatch at commit
  'RateLimited',
  'Unexpected',
  'Aborted',
  'MissingOrMalformedOperationId',
  'NoStorageEntitiesConfigured', // No storage entities are configured for the project
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/**
 * Coarse orchestration error buckets emitted by the service on the async
 * upload/commit poll path (`GET api/storage/operations/{id}/status`). These are
 * NOT members of `STORAGE_ERROR_CODES`; the SDK translates them via
 * {@link mapOperationErrorCode}. See the server-side TODO on
 * `OperationPollBody.errorCode` to replace these with granular RFC codes.
 */
export const DEFAULT_USER_ERROR = 'ORCHESTRATION_USER_ERROR';
export const SYSTEM_ERROR = 'ORCHESTRATION_SYSTEM_ERROR';

const OPERATION_ERROR_MAP: Record<
  string,
  { code: StorageErrorCode; status: number }
> = {
  INVALID_OPERATION_ID: { code: 'MissingOrMalformedOperationId', status: 400 },
  INVALID_FOLDER: { code: 'InvalidFolder', status: 400 },
  INVALID_FILE_NAME: { code: 'InvalidName', status: 400 },
  INVALID_UPLOAD_ID: { code: 'MissingOrMalformedOperationId', status: 400 },
  INVALID_EXPIRY: { code: 'InvalidSasExpiry', status: 400 },
  INVALID_CONTINUATION: { code: 'InvalidContinuation', status: 400 },
  STORAGE_NOT_CONFIGURED: { code: 'NoStorageEntitiesConfigured', status: 400 },
  UPLOAD_SIZE_EXCEEDS_LIMIT: { code: 'TooLarge', status: 400 },
  UNSUPPORTED_CONTENT_TYPE: {
    code: 'UnsupportedContentType',
    status: 400,
  },
  PERMISSION_DENIED: { code: 'PermissionDenied', status: 403 },
  FILE_NOT_FOUND: { code: 'NotFound', status: 404 },
  FOLDER_NOT_FOUND: { code: 'NotFound', status: 404 },
  STORAGE_OBJECT_NOT_FOUND: { code: 'NotFound', status: 404 },
  OPERATION_NOT_FOUND: { code: 'NotFound', status: 404 },
  UPLOAD_ALREADY_IN_PROGRESS: { code: 'Conflict', status: 409 },
  UPLOAD_NOT_AWAITING_COMMIT: { code: 'Conflict', status: 409 },
  DELETE_ALREADY_IN_PROGRESS: { code: 'Conflict', status: 409 },
  UPLOAD_TARGET_EXISTS: { code: 'Conflict', status: 409 },
  STORAGE_OBJECT_UNAVAILABLE: { code: 'Conflict', status: 409 },
  UPLOAD_STAGING_NOT_FOUND: { code: 'NotFound', status: 404 },
  UPLOAD_SIZE_EXCEEDS_DECLARED: { code: 'TooLarge', status: 400 },
  UPLOAD_CONTENT_TYPE_MISMATCH: {
    code: 'UnsupportedContentType',
    status: 400,
  },
  UPLOAD_TARGET_LOCKED: { code: 'Conflict', status: 409 },
  DELETE_TARGET_NOT_FOUND: { code: 'NotFound', status: 404 },
  DELETE_TARGET_LOCKED: { code: 'Conflict', status: 409 },
  [DEFAULT_USER_ERROR]: { code: 'Unexpected', status: 400 },
  [SYSTEM_ERROR]: { code: 'Unexpected', status: 500 },
};

/**
 * Translate a service operation-poll `errorCode` into a stable
 * `StorageErrorCode` plus a representative HTTP status (so retryability derives
 * correctly via {@link isRetryableStorageError}).
 *
 * - `ORCHESTRATION_SYSTEM_ERROR` → `Unexpected` / 500 (transient → retryable).
 * - `ORCHESTRATION_USER_ERROR`   → `Unexpected` / 400 (caller-caused → terminal).
 * - a granular service code maps to a stable SDK code and its original status.
 * - anything else becomes `Unexpected`; a successful poll status is replaced
 *   with 500 because it describes the transport leg, not the failed operation.
 */
export function mapOperationErrorCode(errorCode: string | undefined): {
  code: StorageErrorCode;
  status: number;
} {
  const mapped = errorCode ? OPERATION_ERROR_MAP[errorCode] : undefined;
  if (mapped) {
    return { ...mapped };
  }
  return {
    code: 'Unexpected',
    status: 500, // TODO; making a service side change which will have status code for unexpected errors
  };
}

/**
 * Whether a failure with the given code/status is worth retrying. Used to seed
 * `StorageError.retryable` so callers can offer to reissue the same public SDK
 * operation from the beginning (RFC §3.6). The SDK does not resume a failed
 * orchestration or retry an individual phase. Statuses 500 and above and
 * explicit rate limiting are retryable; everything else is terminal.
 */
export function isRetryableStorageError(
  code: StorageErrorCode,
  status: number
): boolean {
  return code === 'RateLimited' || status >= 500;
}

/**
 * Type guard to check if an error is a StorageError
 */
export function isStorageError(
  error: unknown
): error is import('./StorageFolderClient').StorageError {
  return (
    error instanceof Error &&
    'code' in error &&
    'status' in error &&
    'correlationId' in error &&
    typeof (error as any).code === 'string' &&
    typeof (error as any).status === 'number' &&
    typeof (error as any).correlationId === 'string'
  );
}
