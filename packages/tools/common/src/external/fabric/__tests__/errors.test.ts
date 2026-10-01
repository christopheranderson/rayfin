import { describe, expect, it } from 'vitest';

import {
  buildFabricErrorMessage,
  FabricError,
  getRootActivityId,
  throwFabricError,
} from '../errors.js';

function errorResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

/** Throw via `throwFabricError` and return the rejected error for assertions. */
async function captureError(response: Response): Promise<FabricError> {
  try {
    await throwFabricError(response, 'Fabric API error');
  } catch (error) {
    return error as FabricError;
  }
  throw new Error('expected throwFabricError to throw');
}

describe('throwFabricError', () => {
  it('extracts nested error.message with code instead of rendering [object Object]', async () => {
    const error = await captureError(
      errorResponse(409, {
        error: {
          code: 'ItemDisplayNameAlreadyInUse',
          message: 'The display name is already in use.',
        },
      })
    );

    expect(error).toBeInstanceOf(FabricError);
    expect(error.statusCode).toBe(409);
    expect(error.errorCode).toBe('ItemDisplayNameAlreadyInUse');
    expect(error.message).toContain('The display name is already in use.');
    expect(error.message).toContain('ItemDisplayNameAlreadyInUse');
    expect(error.message).not.toContain('[object Object]');
  });

  it('falls back to the nested error.code when no message is present', async () => {
    const error = await captureError(
      errorResponse(400, { error: { code: 'InvalidRequest' } })
    );

    expect(error.message).toContain('InvalidRequest');
    expect(error.message).not.toContain('[object Object]');
  });

  it('uses a top-level message field', async () => {
    const error = await captureError(
      errorResponse(400, { message: 'bad input' })
    );

    expect(error.message).toContain('bad input');
  });

  it('extracts a top-level errorCode', async () => {
    const error = await captureError(
      errorResponse(503, {
        errorCode: 'CapacityCreationFailure',
        message: 'Capacity creation failed.',
      })
    );

    expect(error.errorCode).toBe('CapacityCreationFailure');
  });

  it('retains Unlicensed separately from generic Unauthorized', async () => {
    const unlicensed = await captureError(
      errorResponse(401, { errorCode: 'Unlicensed' })
    );
    const unauthorized = await captureError(
      errorResponse(401, { errorCode: 'Unauthorized' })
    );

    expect(unlicensed.errorCode).toBe('Unlicensed');
    expect(unauthorized.errorCode).toBe('Unauthorized');
  });

  it('retains UserNotLicensed from a forbidden response', async () => {
    const error = await captureError(
      errorResponse(403, { error: { code: 'UserNotLicensed' } })
    );

    expect(error.statusCode).toBe(403);
    expect(error.errorCode).toBe('UserNotLicensed');
  });

  it('distinguishes a missing delegated permission from resource authorization', async () => {
    const missingPermission = await captureError(
      errorResponse(403, { error: { code: 'InsufficientPrivileges' } })
    );
    const resourceAuthorization = await captureError(
      errorResponse(403, { error: { code: 'Forbidden' } })
    );

    expect(missingPermission.errorCode).toBe('InsufficientPrivileges');
    expect(resourceAuthorization.errorCode).toBe('Forbidden');
  });

  it.each(['TrialAlreadyExists', 'TrialProvisioningInProgress'])(
    'retains the %s conflict code',
    async (errorCode) => {
      const error = await captureError(errorResponse(409, { errorCode }));

      expect(error.statusCode).toBe(409);
      expect(error.errorCode).toBe(errorCode);
    }
  );

  it('uses a string-valued error field', async () => {
    const error = await captureError(
      errorResponse(403, { error: 'forbidden' })
    );

    expect(error.message).toContain('forbidden');
  });

  it('falls back to the raw text for a non-JSON body', async () => {
    const error = await captureError(errorResponse(502, 'upstream exploded'));

    expect(error.message).toContain('upstream exploded');
  });

  it('does not render unrecognized JSON response fields', async () => {
    const error = await captureError(
      errorResponse(401, {
        errorCode: 'Unlicensed',
        operationUrl:
          'https://dailyapi.fabric.microsoft.com/v1/operations/secret',
        loginHint: 'user@example.com',
      })
    );

    expect(error.message).toContain('Unlicensed');
    expect(error.message).not.toContain('operationUrl');
    expect(error.message).not.toContain('dailyapi.fabric.microsoft.com');
    expect(error.message).not.toContain('user@example.com');
  });

  it('renders an explicitly allowlisted errors detail', async () => {
    const error = await captureError(
      errorResponse(400, { errors: [{ detail: 'lakehouse disk full' }] })
    );

    expect(error.message).toContain('lakehouse disk full');
  });

  it('does not render arbitrary fields from unrecognized JSON', async () => {
    const error = await captureError(
      errorResponse(400, {
        accessToken: 'secret-token',
        objectId: 'sensitive-object-id',
      })
    );

    expect(error.message).not.toContain('secret-token');
    expect(error.message).not.toContain('sensitive-object-id');
    expect(error.message).not.toContain('accessToken');
    expect(error.message).not.toContain('objectId');
  });

  it('keeps the actionable part of a URL but strips its parameters', async () => {
    const error = await captureError(
      errorResponse(403, {
        error: {
          code: 'Forbidden',
          message:
            'Open https://example.test/enroll?loginHint=user@example.com for user@example.com.',
        },
      })
    );

    // The link survives so the Builder still has a next step (R3).
    expect(error.message).toContain('https://example.test/enroll');
    expect(error.message).toContain('[redacted identity]');
    expect(error.message).not.toContain('loginHint=');
    expect(error.message).not.toContain('user@example.com');
  });

  it('bounds non-JSON response details', async () => {
    const error = await captureError(errorResponse(502, 'x'.repeat(2000)));

    expect(error.message.length).toBeLessThan(600);
  });

  it('includes the root activity id from the response headers', async () => {
    const error = await captureError(
      errorResponse(
        400,
        { error: { code: 'X', message: 'nope' } },
        { 'x-ms-root-activity-id': 'act-123' }
      )
    );

    expect(error.message).toContain('act-123');
  });

  it('attaches the Retry-After delay so retry logic can read it', async () => {
    const error = await captureError(
      errorResponse(429, { message: 'slow down' }, { 'Retry-After': '5' })
    );

    expect(error.statusCode).toBe(429);
    expect(error.errorCode).toBeUndefined();
    expect(error.retryAfterMs).toBe(5000);
  });
});

describe('buildFabricErrorMessage', () => {
  it('combines context, status, details, and root activity id', () => {
    const response = errorResponse(
      404,
      {},
      { 'x-ms-root-activity-id': 'act-9' }
    );

    const message = buildFabricErrorMessage(
      response,
      'Fabric API error',
      'not found'
    );

    expect(message).toContain('Fabric API error: 404');
    expect(message).toContain('Details: not found');
    expect(message).toContain('RootActivityId: act-9');
  });
});

describe('getRootActivityId', () => {
  it('prefers x-ms-root-activity-id', () => {
    const response = errorResponse(
      500,
      {},
      { 'x-ms-root-activity-id': 'root-1', RequestId: 'req-1' }
    );

    expect(getRootActivityId(response)).toBe('root-1');
  });

  it('falls back to RequestId', () => {
    const response = errorResponse(500, {}, { RequestId: 'req-2' });

    expect(getRootActivityId(response)).toBe('req-2');
  });

  it('returns undefined when neither header is present', () => {
    const response = errorResponse(500, {});

    expect(getRootActivityId(response)).toBeUndefined();
  });
});
