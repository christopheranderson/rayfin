import { describe, it, expect } from 'vitest';

import {
  isStorageError,
  isRetryableStorageError,
  mapOperationErrorCode,
} from '../storageErrorCodes';

describe('mapOperationErrorCode', () => {
  it('maps the system bucket to a retryable Unexpected/500', () => {
    const { code, status } = mapOperationErrorCode(
      'ORCHESTRATION_SYSTEM_ERROR'
    );
    expect(code).toBe('Unexpected');
    expect(status).toBe(500);
    expect(isRetryableStorageError(code, status)).toBe(true);
  });

  it('maps the user bucket to a terminal Unexpected/400', () => {
    const { code, status } = mapOperationErrorCode('ORCHESTRATION_USER_ERROR');
    expect(code).toBe('Unexpected');
    expect(status).toBe(400);
    expect(isRetryableStorageError(code, status)).toBe(false);
  });

  it.each([
    ['INVALID_OPERATION_ID', 'MissingOrMalformedOperationId', 400],
    ['INVALID_FOLDER', 'InvalidFolder', 400],
    ['INVALID_FILE_NAME', 'InvalidName', 400],
    ['INVALID_UPLOAD_ID', 'MissingOrMalformedOperationId', 400],
    ['INVALID_EXPIRY', 'InvalidSasExpiry', 400],
    ['INVALID_CONTINUATION', 'InvalidContinuation', 400],
    ['STORAGE_NOT_CONFIGURED', 'NoStorageEntitiesConfigured', 400],
    ['UPLOAD_SIZE_EXCEEDS_LIMIT', 'TooLarge', 400],
    ['UNSUPPORTED_CONTENT_TYPE', 'UnsupportedContentType', 400],
    ['PERMISSION_DENIED', 'PermissionDenied', 403],
    ['FILE_NOT_FOUND', 'NotFound', 404],
    ['FOLDER_NOT_FOUND', 'NotFound', 404],
    ['STORAGE_OBJECT_NOT_FOUND', 'NotFound', 404],
    ['OPERATION_NOT_FOUND', 'NotFound', 404],
    ['UPLOAD_ALREADY_IN_PROGRESS', 'Conflict', 409],
    ['UPLOAD_NOT_AWAITING_COMMIT', 'Conflict', 409],
    ['DELETE_ALREADY_IN_PROGRESS', 'Conflict', 409],
    ['UPLOAD_TARGET_EXISTS', 'Conflict', 409],
    ['STORAGE_OBJECT_UNAVAILABLE', 'Conflict', 409],
    ['UPLOAD_STAGING_NOT_FOUND', 'NotFound', 404],
    ['UPLOAD_SIZE_EXCEEDS_DECLARED', 'TooLarge', 400],
    ['UPLOAD_CONTENT_TYPE_MISMATCH', 'UnsupportedContentType', 400],
    ['UPLOAD_TARGET_LOCKED', 'Conflict', 409],
    ['DELETE_TARGET_NOT_FOUND', 'NotFound', 404],
    ['DELETE_TARGET_LOCKED', 'Conflict', 409],
  ])('maps %s to %s/%i', (serviceCode, sdkCode, status) => {
    expect(mapOperationErrorCode(serviceCode)).toEqual({
      code: sdkCode,
      status,
    });
  });

  it('does not expose a successful poll status for an unknown failure', () => {
    expect(mapOperationErrorCode('SOMETHING_NEW')).toEqual({
      code: 'Unexpected',
      status: 500,
    });
    expect(mapOperationErrorCode(undefined)).toEqual({
      code: 'Unexpected',
      status: 500,
    });

    const unknown = mapOperationErrorCode('SOMETHING_NEW');
    expect(isRetryableStorageError(unknown.code, unknown.status)).toBe(true);
  });
});

describe('isStorageError', () => {
  it('accepts errors with the public storage error shape', () => {
    const error = Object.assign(new Error('upload failed'), {
      code: 'Unexpected',
      status: 500,
      correlationId: 'correlation-id',
      retryable: true,
    });

    expect(isStorageError(error)).toBe(true);
  });

  it.each([
    new Error('plain error'),
    { code: 'Unexpected', status: 500, correlationId: 'correlation-id' },
    Object.assign(new Error('wrong status'), {
      code: 'Unexpected',
      status: '500',
      correlationId: 'correlation-id',
    }),
  ])('rejects non-storage errors', (error) => {
    expect(isStorageError(error)).toBe(false);
  });
});
