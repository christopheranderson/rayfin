import { describe, it, expect, vi, afterEach } from 'vitest';

import { ApiClient } from '../ApiClient.js';
import { NetworkError } from '../errors.js';

/**
 * Regression tests for the error message built from a failed response body.
 *
 * A failed Fabric user-data-function invocation puts its detail in `errors[]`
 * with no top-level `message`, which fell through to a bare `HTTP Error 500`.
 */
describe('ApiClient error messages', () => {
  function createClient(): ApiClient {
    return new ApiClient({
      baseUrl: 'https://api.example.com',
      publishableKey: 'pk_test_123',
    });
  }

  function mockFailure(body: unknown, status = 500): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { httpStatus: 400, status: 'BadRequest', errorCode: 'MissingInput' },
    { httpStatus: 400, status: 'BadRequest', errorCode: 'InvalidInput' },
    { httpStatus: 422, status: 'BadRequest', errorCode: 'UserThrown' },
    {
      httpStatus: 403,
      status: 'ResponseTooLarge',
      errorCode: 'ResponseTooLarge',
    },
    { httpStatus: 500, status: 'Failed', errorCode: 'InternalError' },
  ])(
    'preserves local UDF diagnostics for HTTP $httpStatus ($errorCode) without retrying',
    async ({ httpStatus, status, errorCode }) => {
      const onRefreshNeeded = vi.fn(async () => {});
      mockFailure(
        {
          functionName: 'local_function',
          invocationId: 'local-invocation-id',
          status,
          output: '',
          errors: [
            {
              errorCode,
              message: 'Function rejected the request',
              properties: {},
            },
          ],
        },
        httpStatus
      );
      const client = new ApiClient({
        baseUrl: 'http://localhost:7071',
        publishableKey: 'pk_test_123',
        fetch: globalThis.fetch,
        onRefreshNeeded,
      });

      const invocation = client.post('/api/local_function', {});

      await expect(invocation).rejects.toBeInstanceOf(NetworkError);
      await expect(invocation).rejects.toMatchObject({
        status: httpStatus,
        message: `${errorCode}: Function rejected the request`,
        workload: {
          errorCode,
          functionName: 'local_function',
          invocationId: 'local-invocation-id',
          status,
        },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onRefreshNeeded).not.toHaveBeenCalled();
    }
  );

  it('surfaces the code and message from a workload failure envelope', async () => {
    // Verbatim from a deployed app whose semantic-model query was rejected.
    mockFailure({
      functionName: 'rayfin_semantic_model_v1',
      invocationId: '00000000-0000-0000-0000-000000000000',
      status: 'Failed',
      errors: [
        {
          errorCode: 'WorkloadException',
          subErrorCode: 'Unauthorized',
          message:
            "User data function: 'rayfin_semantic_model_v1' invocation failed.",
        },
      ],
    });

    await expect(createClient().get('/connector-invoke/x')).rejects.toThrow(
      /WorkloadException\/Unauthorized: User data function/u
    );
  });

  it('does not report a bare status code when the body explains the failure', async () => {
    mockFailure({
      status: 'Failed',
      errors: [
        { errorCode: 'WorkloadException', subErrorCode: 'Unauthorized' },
      ],
    });

    await expect(createClient().get('/connector-invoke/x')).rejects.not.toThrow(
      /^HTTP Error 500$/u
    );
  });

  it('joins multiple envelope errors', async () => {
    mockFailure({
      errors: [
        { errorCode: 'A', message: 'first' },
        { errorCode: 'B', message: 'second' },
      ],
    });

    await expect(createClient().get('/x')).rejects.toThrow(
      /A: first; B: second/u
    );
  });

  it('keeps preferring a top-level message when the body has one', async () => {
    // Precedence is unchanged: the envelope is only a fallback, so an API that
    // already returns a good message is unaffected.
    mockFailure({ message: 'Entity not found', errors: [{ errorCode: 'X' }] });

    await expect(createClient().get('/x')).rejects.toThrow('Entity not found');
  });

  it('keeps preferring an OAuth error_description', async () => {
    mockFailure({
      error_description: 'The refresh token expired',
      errors: [{ errorCode: 'X', message: 'ignored' }],
    });

    await expect(createClient().get('/x')).rejects.toThrow(
      'The refresh token expired'
    );
  });

  it('keeps a bare string entry verbatim', async () => {
    // `errors` is `Array<string | Record<string, any>>` on the wire, and
    // FunctionClient already reads both. Dropping strings here would lose the
    // whole diagnosis for the simpler of the two shapes.
    mockFailure({ errors: ['User data function invocation failed.'] });

    await expect(createClient().get('/x')).rejects.toThrow(
      'User data function invocation failed.'
    );
  });

  it('serializes an object with none of the preferred fields', async () => {
    mockFailure({ errors: [{ code: 'X', detail: 'Y' }] });

    await expect(createClient().get('/x')).rejects.toThrow(
      /\{"code":"X","detail":"Y"\}/u
    );
  });

  it('bounds a large unfamiliar entry', async () => {
    // A response body has no size contract and this text reaches logs and UI.
    mockFailure({ errors: [{ blob: 'z'.repeat(5000) }] });

    let message = '';
    await createClient()
      .get('/x')
      .catch((err: Error) => {
        message = err.message;
      });

    expect(message).toContain('…');
    expect(message.length).toBeLessThan(400);
  });

  it('mixes shapes in one envelope', async () => {
    mockFailure({
      errors: [
        'plain string',
        { errorCode: 'A', message: 'structured' },
        { odd: 1 },
      ],
    });

    await expect(createClient().get('/x')).rejects.toThrow(
      'plain string; A: structured; {"odd":1}'
    );
  });

  it('survives a body that parses but cannot be serialized', async () => {
    // A cycle cannot arrive here — JSON has no references — but a body deep
    // enough to parse can still exceed the stack on stringify, and the catch
    // turns that into the ordinary HTTP failure. Built as raw text because
    // stringifying the fixture would hit the same limit.
    const depth = 50000;
    const text =
      '{"errors":[' + '{"n":'.repeat(depth) + '{}' + '}'.repeat(depth) + ']}';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(text, {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    let message = '';
    await createClient()
      .get('/x')
      .catch((err: Error) => {
        message = err.message;
      });

    // Either outcome is fine — the point is that it stays an HTTP failure.
    // Which one depends on the engine's stack, so both are accepted.
    expect(message).toMatch(/HTTP Error 500|^\{"n"/u);
    expect(message).not.toMatch(/call stack|circular/iu);
  });

  it('falls back to the status code when the body carries nothing usable', async () => {
    for (const body of [
      {},
      { errors: [] },
      { errors: 'not-an-array' },
      { errors: [{}] },
      { errors: [null] },
      { errors: [''] },
      // Recognized field, empty value: nothing to say, so serializing it would
      // trade a clear status code for noise.
      { errors: [{ errorCode: '' }] },
    ]) {
      mockFailure(body);
      await expect(createClient().get('/x')).rejects.toThrow(/HTTP Error 500/u);
    }
  });
});
