import { translateStaticHostingAccessError } from '@microsoft/rayfin-tools-common/_internal/services/runtime-settings';
import { describe, expect, it } from 'vitest';

import { throwIfNotOk } from '../services/fabric/http-client';

describe('throwIfNotOk error detail extraction', () => {
  it('returns the body text on a successful response', async () => {
    await expect(throwIfNotOk(makeResponse(200, 'body'), 'ctx')).resolves.toBe(
      'body'
    );
  });

  it('extracts a root message', async () => {
    await expect(
      throwIfNotOk(makeResponse(400, { message: 'Root detail' }), 'ctx')
    ).rejects.toThrow(/Root detail/);
  });

  it('extracts a nested error message', async () => {
    await expect(
      throwIfNotOk(
        makeResponse(400, { error: { message: 'Nested detail' } }),
        'ctx'
      )
    ).rejects.toThrow(/Nested detail/);
  });

  it('extracts a string error', async () => {
    await expect(
      throwIfNotOk(makeResponse(400, { error: 'String detail' }), 'ctx')
    ).rejects.toThrow(/String detail/);
  });

  it('falls back to the raw body when nothing is a string', async () => {
    await expect(
      throwIfNotOk(makeResponse(400, { error: { code: 'OnlyACode' } }), 'ctx')
    ).rejects.toThrow(/OnlyACode/);
  });

  it('falls back to the raw body when the response is not JSON', async () => {
    await expect(
      throwIfNotOk(makeResponse(500, 'plain failure'), 'ctx')
    ).rejects.toThrow(/plain failure/);
  });

  // The translator does string matching, so an object reaching it would throw
  // `details.includes is not a function` instead of reporting the failure.
  it('passes a string to the translator for an unrelated nested envelope', async () => {
    await expect(
      throwIfNotOk(
        makeResponse(400, {
          error: { code: 'UnrelatedFailure', message: 'Unrelated failure' },
        }),
        'ctx',
        translateStaticHostingAccessError
      )
    ).rejects.toThrow(/Unrelated failure/);
  });

  it('translates a known posture code carried in a nested envelope', async () => {
    await expect(
      throwIfNotOk(
        makeResponse(400, {
          error: {
            code: 'StaticHostingPostureRequired',
            message: 'anonymousAccess is required',
          },
        }),
        'ctx',
        translateStaticHostingAccessError
      )
    ).rejects.toThrow(/services\.staticHosting\.assetAccess/);
  });

  it('translates a known posture message with no code', async () => {
    await expect(
      throwIfNotOk(
        makeResponse(400, {
          message: 'Static hosting requires an explicit access posture',
        }),
        'ctx',
        translateStaticHostingAccessError
      )
    ).rejects.toThrow(/services\.staticHosting\.assetAccess/);
  });
});

function makeResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
  });
}
