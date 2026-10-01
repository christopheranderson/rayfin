/**
 * Tests for the direct Power BI execution path.
 *
 * The contract these lock down is that `executeDaxDirect` **never throws**:
 * every failure mode has to come back as a failed envelope carrying the right
 * category, because a caller that has to try/catch on some paths but not others
 * gets no benefit from the uniform envelope at all.
 */

import { isConnectorError } from '@microsoft/rayfin-connectors';
import { describe, it, expect } from 'vitest';

import {
  executeDaxDirect,
  resolveBaseUrl,
  resolveTarget,
  toNetworkErrorResponse,
} from '../directExecute';
import { DEFAULT_POWER_BI_BASE_URL, derivePowerBiBaseUrl } from '../endpoints';
import { toQueryResult } from '../queryResult';

import {
  arrowResponse,
  bodyOf,
  headerOf,
  httpReturning,
  httpThrowing,
  TARGET,
} from './fixtures';

describe('resolveTarget', () => {
  it.each([
    ['a plain value', TARGET],
    ['a resolver function', () => TARGET],
  ])('resolves %s', (_label, target) => {
    expect(resolveTarget(target)).toEqual(TARGET);
  });

  it.each([
    ['undefined', undefined],
    ['a resolver returning undefined', () => undefined],
    ['a missing workspaceId', { workspaceId: '', itemId: 'model-1' }],
    ['a missing itemId', { workspaceId: 'ws-1', itemId: '' }],
  ])('returns undefined for %s', (_label, target) => {
    expect(
      resolveTarget(target as Parameters<typeof resolveTarget>[0])
    ).toBeUndefined();
  });
});

describe('resolveBaseUrl', () => {
  it('defaults to the production Power BI base', () => {
    expect(resolveBaseUrl({})).toBe(DEFAULT_POWER_BI_BASE_URL);
  });

  it('derives the base from endpoints', () => {
    expect(
      resolveBaseUrl({
        endpoints: { fabricApi: 'https://daily.fabric.test/v1' },
      })
    ).toBe('https://daily.fabric.test/v1.0/myorg');
  });

  it('prefers an explicit baseUrl over endpoints', () => {
    expect(
      resolveBaseUrl({
        baseUrl: 'https://explicit.test/v1.0/myorg',
        endpoints: { fabricApi: 'https://ignored.test/v1' },
      })
    ).toBe('https://explicit.test/v1.0/myorg');
  });

  it.each([
    [
      'https://api.fabric.microsoft.com/v1',
      'https://api.fabric.microsoft.com/v1.0/myorg',
    ],
    [
      'https://api.fabric.microsoft.com/v1/',
      'https://api.fabric.microsoft.com/v1.0/myorg',
    ],
  ])('derivePowerBiBaseUrl(%s) -> %s', (fabricApi, expected) => {
    expect(derivePowerBiBaseUrl({ fabricApi })).toBe(expected);
  });
});

describe('executeDaxDirect request shape', () => {
  it('posts the DAX query to the Arrow endpoint', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales');

    expect(http.calls[0].url).toBe(
      `${DEFAULT_POWER_BI_BASE_URL}/groups/ws-1/datasets/model-1/executeDaxQueries`
    );
    expect(http.calls[0].init?.method).toBe('POST');
    expect(bodyOf(http.calls[0])).toEqual({ query: 'EVALUATE Sales' });
  });

  it('omits /groups for My Workspace', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(
      http,
      { workspaceId: 'me', itemId: 'model-1' },
      'EVALUATE Sales'
    );

    expect(http.calls[0].url).toBe(
      `${DEFAULT_POWER_BI_BASE_URL}/datasets/model-1/executeDaxQueries`
    );
  });

  it('forwards every DAX query option', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales', {
      culture: 'en-GB',
      schemaOnly: true,
      queryTimeout: 45,
      resultSetRowCountLimit: 500,
    });

    expect(bodyOf(http.calls[0])).toEqual({
      query: 'EVALUATE Sales',
      culture: 'en-GB',
      schemaOnly: true,
      queryTimeout: 45,
      resultSetRowCountLimit: 500,
    });
  });

  it('omits options that were not supplied', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales', {
      culture: 'fr-FR',
    });

    expect(bodyOf(http.calls[0])).toEqual({
      query: 'EVALUATE Sales',
      culture: 'fr-FR',
    });
  });

  it('sends telemetry correlation headers', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales', {
      sessionId: 'session-abc',
    });

    expect(headerOf(http.calls[0], 'activityid')).toBe('session-abc');
    expect(headerOf(http.calls[0], 'requestid')).toMatch(/\S/);
  });

  it('honours a baseUrl override', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales', {
      baseUrl: 'https://daily.powerbi.test/v1.0/myorg',
    });

    expect(http.calls[0].url).toBe(
      'https://daily.powerbi.test/v1.0/myorg/groups/ws-1/datasets/model-1/executeDaxQueries'
    );
  });
});

describe('executeDaxDirect token override', () => {
  it('sends no Authorization header when no provider is configured', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales');

    expect(headerOf(http.calls[0], 'Authorization')).toBeUndefined();
  });

  it('prefixes a bare token with the Bearer scheme', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales', {
      getToken: () => 'fabric-token',
    });

    expect(headerOf(http.calls[0], 'Authorization')).toBe(
      'Bearer fabric-token'
    );
  });

  it('accepts an async provider', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales', {
      getToken: async () => 'async-token',
    });

    expect(headerOf(http.calls[0], 'Authorization')).toBe('Bearer async-token');
  });

  it('leaves a token that already carries the scheme untouched', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales', {
      getToken: () => 'Bearer already-prefixed',
    });

    expect(headerOf(http.calls[0], 'Authorization')).toBe(
      'Bearer already-prefixed'
    );
  });

  it.each([
    ['returns undefined', () => undefined],
    ['returns an empty string', () => ''],
    [
      'throws',
      (): string => {
        throw new Error('no credential');
      },
    ],
  ])(
    'falls back to the connectors token when the provider %s',
    async (_label, getToken) => {
      const http = httpReturning(arrowResponse());

      const result = toQueryResult(
        await executeDaxDirect(http, TARGET, 'EVALUATE Sales', { getToken })
      );

      expect(headerOf(http.calls[0], 'Authorization')).toBeUndefined();
      expect(result.status).toBe('success');
    }
  );

  it('does not let the token displace the correlation id', async () => {
    const http = httpReturning(arrowResponse());

    await executeDaxDirect(http, TARGET, 'EVALUATE Sales', {
      sessionId: 'session-abc',
      getToken: () => 'fabric-token',
    });

    expect(headerOf(http.calls[0], 'activityid')).toBe('session-abc');
    expect(headerOf(http.calls[0], 'requestid')).toMatch(/\S/);
  });
});

describe('executeDaxDirect success', () => {
  it('decodes Arrow rows and keeps the server request id', async () => {
    const http = httpReturning(arrowResponse());

    const result = toQueryResult(
      await executeDaxDirect(http, TARGET, 'EVALUATE Sales')
    );

    expect(result).toEqual({
      status: 'success',
      requestId: 'pbi-request-id',
      table: {
        columns: [
          { name: 'Sales[Region]', dataType: 'String' },
          { name: 'Sales[Units]', dataType: 'Double' },
        ],
        rows: [
          ['North', 10],
          ['South', 20],
        ],
      },
    });
  });

  it('falls back to the client request id when the header is absent', async () => {
    const http = httpReturning(new Response(new Uint8Array(), { status: 200 }));

    const response = await executeDaxDirect(http, TARGET, 'EVALUATE Sales');

    // The id sent up front is the one reported back, so an error is always
    // quotable even when no server assigned one.
    expect(response.output.requestId).toBe(
      headerOf(http.calls[0], 'requestid')
    );
    expect(response.output.requestId).toMatch(/\S/);
  });
});

describe('executeDaxDirect failure handling', () => {
  it('maps a structured Power BI error to an api failure', async () => {
    const http = httpReturning(
      new Response(
        JSON.stringify({
          error: {
            code: 'PowerBINotAuthorizedException',
            message: 'The user does not have access to the dataset.',
          },
        }),
        { status: 401, headers: { requestid: 'pbi-401' } }
      )
    );

    const result = toQueryResult(
      await executeDaxDirect(http, TARGET, 'EVALUATE Sales')
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.category).toBe('api');
    expect(result.error.code).toBe('PowerBINotAuthorizedException');
    expect(result.error.message).toBe(
      'The user does not have access to the dataset.'
    );
    expect(result.error.details).toContain('PowerBINotAuthorizedException');
    expect(result.requestId).toBe('pbi-401');
  });

  it('falls back to the raw body for a non-JSON error', async () => {
    const http = httpReturning(
      new Response('<html>Bad Gateway</html>', { status: 502 })
    );

    const result = toQueryResult(
      await executeDaxDirect(http, TARGET, 'EVALUATE Sales')
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error).toMatchObject({
      category: 'api',
      code: '502',
      message: '<html>Bad Gateway</html>',
    });
  });

  it('reports an empty error body as the status code', async () => {
    const http = httpReturning(new Response('', { status: 429 }));

    const result = toQueryResult(
      await executeDaxDirect(http, TARGET, 'EVALUATE Sales')
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.message).toBe(
      'Power BI returned HTTP 429 with an empty body.'
    );
    // Nothing about a 429 says the caller lacks access, so the connector
    // stays quiet and lets the caller derive a hint from the category.
    expect(result.error.recoveryHint).toBeUndefined();
  });

  it('blames the token, not workspace access, for a 401 with an empty body', async () => {
    // AB#2247879. Power BI describes a permissions failure rather than
    // answering with nothing, so an empty body means the request never got
    // as far as an access check. Recommending a permissions audit here sends
    // the developer after something that was never the cause.
    const http = httpReturning(new Response('', { status: 401 }));

    const result = toQueryResult(
      await executeDaxDirect(http, TARGET, 'EVALUATE Sales')
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.category).toBe('api');
    expect(result.error.recoveryHint).toContain(
      'https://analysis.windows.net/powerbi/api'
    );
    expect(result.error.recoveryHint).toMatch(/check the token first/i);
  });

  it('recommends a permissions check for a 401 that carries a body', async () => {
    const http = httpReturning(
      new Response(
        JSON.stringify({
          error: {
            code: 'PowerBINotAuthorizedException',
            message: 'The user does not have access to the dataset.',
          },
        }),
        { status: 401 }
      )
    );

    const result = toQueryResult(
      await executeDaxDirect(http, TARGET, 'EVALUATE Sales')
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.recoveryHint).toContain('at least Viewer access');
  });

  it('returns failures the shared connector contract recognises', async () => {
    const http = httpReturning(new Response('', { status: 401 }));

    const result = toQueryResult(
      await executeDaxDirect(http, TARGET, 'EVALUATE Sales')
    );

    // The CLI reads failures through this guard without knowing which
    // connector produced them, so conformance is asserted rather than assumed.
    expect(isConnectorError(result)).toBe(true);
  });

  it('returns a network failure instead of throwing', async () => {
    const cause = Object.assign(
      new Error('getaddrinfo ENOTFOUND api.powerbi.com'),
      {
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname: 'api.powerbi.com',
      }
    );
    const http = httpThrowing(
      Object.assign(new TypeError('fetch failed'), { cause })
    );

    const result = toQueryResult(
      await executeDaxDirect(http, TARGET, 'EVALUATE Sales')
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.category).toBe('network');
    expect(result.error.message).toBe(
      'fetch failed: getaddrinfo ENOTFOUND api.powerbi.com'
    );
    expect(result.error.details).toBe(
      'code=ENOTFOUND, syscall=getaddrinfo, hostname=api.powerbi.com'
    );
    // A network failure never reached a server, so the id must still be the
    // client-generated one rather than an empty string.
    expect(result.requestId).toBe(headerOf(http.calls[0], 'requestid'));
  });

  it('returns an unknown failure for a corrupt Arrow stream', async () => {
    const http = httpReturning(
      new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { status: 200 })
    );

    const result = toQueryResult(
      await executeDaxDirect(http, TARGET, 'EVALUATE Sales')
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.category).toBe('unknown');
    expect(result.error.message).toMatch(/Failed to parse response/);
  });
});

describe('toNetworkErrorResponse', () => {
  it('does not repeat the message when the cause duplicates it', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: { message: 'fetch failed' },
    });

    const result = toQueryResult(toNetworkErrorResponse(err, 'req-1'));

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.message).toBe('fetch failed');
  });

  it('handles a cause with no structured fields', () => {
    const result = toQueryResult(
      toNetworkErrorResponse(new TypeError('Failed to fetch'), 'req-2')
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error).toEqual({
      category: 'network',
      message: 'Failed to fetch',
    });
  });

  it('stringifies a non-Error throw', () => {
    const result = toQueryResult(toNetworkErrorResponse('boom', 'req-3'));

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.message).toBe('boom');
  });
});
