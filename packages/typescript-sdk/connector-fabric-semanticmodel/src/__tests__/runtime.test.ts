/**
 * Tests for the `fabric-semanticmodel` invoke middleware.
 *
 * The middleware picks an execution path from the host environment and returns
 * the connector's public result, so these tests drive it through a helper that
 * reproduces the connectors layer's real ordering rather than calling hooks in
 * isolation. The layer would apply `decodeBinary` after `invoke`, and this
 * connector deliberately registers no such hook, so the helper also pins the
 * fact that nothing downstream is left to run.
 *
 * Arrow fixtures are produced with apache-arrow's own `tableToIPC` so both
 * paths are exercised against real IPC bytes.
 */

import type { InvokeContext, InvokeNext } from '@microsoft/rayfin-connectors';
import { describe, it, expect, vi } from 'vitest';

import { toQueryResult, type SemanticModelQueryResult } from '../queryResult';
import { fabricSemanticModel } from '../runtime';
import type { FabricSemanticModelTabularResponse } from '../types';

import {
  arrowResponse,
  arrowStream,
  bodyOf,
  buildContext,
  httpReturning,
  SAMPLE_ROWS,
  TARGET,
} from './fixtures';

/**
 * A wire response of the shape the delegated transport hands back when it
 * returns JSON rather than Arrow bytes.
 *
 * Typed rather than cast, so the fixture stays honest about where each field
 * lives: `requestId` hangs off `output`, not the envelope.
 */
const DELEGATED_RESPONSE: FabricSemanticModelTabularResponse = {
  status: 'Succeeded',
  output: {
    tables: [{ rows: [{ 'Sales[Region]': 'East' }] }],
    requestId: 'delegated-request-id',
  },
  errors: [],
};

/**
 * Run `executeQuery` the way `SemanticConnectorClient.createProxy` does: call
 * the middleware, then apply `decodeBinary` only when the result is binary.
 *
 * The connector registers no `decodeBinary`, because the middleware decodes
 * internally so it can normalise. Keeping the layer's ordering here proves the
 * result needs no further processing rather than assuming it.
 */
async function runOperation(
  runtime: ReturnType<typeof fabricSemanticModel>,
  ctx: InvokeContext,
  next: InvokeNext
): Promise<unknown> {
  const op = runtime.operations?.executeQuery;
  const result = await op!.invoke!(ctx, next);
  const decode = op?.decodeBinary;
  if (decode) {
    if (result instanceof ArrayBuffer) return decode(result);
    if (ArrayBuffer.isView(result)) {
      const view = result as ArrayBufferView;
      return decode(
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
      );
    }
  }
  return result;
}

describe('invoke routing', () => {
  it.each([
    [
      'a standalone host',
      buildContext({
        host: { type: 'standalone' },
        http: httpReturning(arrowResponse()),
      }),
    ],
    [
      'an embedded host',
      buildContext({
        host: { type: 'embedded' },
        http: httpReturning(arrowResponse()),
      }),
    ],
    ['a CLI host with no http client', buildContext({ http: undefined })],
    [
      'a CLI host with an empty query',
      buildContext({
        input: { query: '' },
        http: httpReturning(arrowResponse()),
      }),
    ],
    [
      'a CLI host with no input',
      buildContext({ input: undefined, http: httpReturning(arrowResponse()) }),
    ],
  ])('delegates to next for %s', async (_label, ctx) => {
    const next = vi.fn<InvokeNext>().mockResolvedValue(DELEGATED_RESPONSE);
    const runtime = fabricSemanticModel({ target: TARGET });

    // Delegating still returns the connector's own result shape, so a caller
    // cannot tell which transport ran.
    const result = (await runOperation(
      runtime,
      ctx,
      next
    )) as SemanticModelQueryResult;

    // Assert the fields outright rather than only against `toQueryResult` of the
    // same fixture, which would hold even if normalisation dropped them.
    expect(result).toEqual({
      status: 'success',
      table: {
        columns: [{ name: 'Sales[Region]', dataType: 'unknown' }],
        rows: [['East']],
      },
      requestId: 'delegated-request-id',
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('delegates when no target is configured', async () => {
    const next = vi.fn<InvokeNext>().mockResolvedValue(DELEGATED_RESPONSE);
    const runtime = fabricSemanticModel();
    const http = httpReturning(arrowResponse());

    await expect(
      runOperation(runtime, buildContext({ http }), next)
    ).resolves.toEqual(toQueryResult(DELEGATED_RESPONSE));
    expect(http.calls).toHaveLength(0);
  });

  it('delegates when a target resolver returns nothing', async () => {
    const next = vi.fn<InvokeNext>().mockResolvedValue(DELEGATED_RESPONSE);
    const runtime = fabricSemanticModel({ target: () => undefined });

    await expect(
      runOperation(
        runtime,
        buildContext({ http: httpReturning(arrowResponse()) }),
        next
      )
    ).resolves.toEqual(toQueryResult(DELEGATED_RESPONSE));
    expect(next).toHaveBeenCalledOnce();
  });

  it('resolves the target lazily, once per call', async () => {
    const resolver = vi.fn().mockReturnValue(TARGET);
    const runtime = fabricSemanticModel({ target: resolver });
    const http = httpReturning(arrowResponse());

    // The resolver must not run at construction time. The target may not be
    // knowable until the process is configured.
    expect(resolver).not.toHaveBeenCalled();

    await runOperation(runtime, buildContext({ http }), vi.fn<InvokeNext>());

    expect(resolver).toHaveBeenCalledOnce();
  });

  it('short-circuits the CLI path without calling next', async () => {
    const next = vi.fn<InvokeNext>();
    const runtime = fabricSemanticModel({ target: TARGET });
    const http = httpReturning(arrowResponse());

    const result = (await runOperation(
      runtime,
      buildContext({ http }),
      next
    )) as SemanticModelQueryResult;

    expect(next).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
  });

  it('does not fall back to next when Power BI rejects the call', async () => {
    const next = vi.fn<InvokeNext>().mockResolvedValue(DELEGATED_RESPONSE);
    const runtime = fabricSemanticModel({ target: TARGET });
    const http = httpReturning(
      new Response(
        JSON.stringify({ error: { code: 'Denied', message: 'No.' } }),
        {
          status: 403,
        }
      )
    );

    const result = (await runOperation(
      runtime,
      buildContext({ http }),
      next
    )) as SemanticModelQueryResult;

    // Falling through would hide the real reason behind a transport that would
    // fail in exactly the same way.
    expect(next).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('Denied');
  });

  it('forwards runtime query options to the request', async () => {
    const runtime = fabricSemanticModel({
      target: TARGET,
      resultSetRowCountLimit: 100,
      culture: 'en-US',
    });
    const http = httpReturning(arrowResponse());

    await runOperation(runtime, buildContext({ http }), vi.fn<InvokeNext>());

    expect(bodyOf(http.calls[0])).toEqual({
      query: 'EVALUATE Sales',
      culture: 'en-US',
      resultSetRowCountLimit: 100,
    });
  });

  it('forwards a row limit carried on the input', async () => {
    const runtime = fabricSemanticModel({ target: TARGET });
    const http = httpReturning(arrowResponse());

    await runOperation(
      runtime,
      buildContext({
        http,
        input: { query: 'EVALUATE Sales', resultSetRowCountLimit: 25 },
      }),
      vi.fn<InvokeNext>()
    );

    expect(bodyOf(http.calls[0])).toEqual({
      query: 'EVALUATE Sales',
      resultSetRowCountLimit: 25,
    });
  });

  it('lets a row limit on the input override the runtime option', async () => {
    const runtime = fabricSemanticModel({
      target: TARGET,
      resultSetRowCountLimit: 100,
      culture: 'en-US',
    });
    const http = httpReturning(arrowResponse());

    await runOperation(
      runtime,
      buildContext({
        http,
        input: { query: 'EVALUATE Sales', resultSetRowCountLimit: 25 },
      }),
      vi.fn<InvokeNext>()
    );

    // The per-call value wins, and the other runtime options are untouched.
    expect(bodyOf(http.calls[0])).toEqual({
      query: 'EVALUATE Sales',
      culture: 'en-US',
      resultSetRowCountLimit: 25,
    });
  });

  // The input crosses a trust boundary: an agent composes it, so a value that
  // is not a usable row count must not reach Power BI. Falling back to the
  // runtime option keeps the connector's own configuration in force.
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
    ['a numeric string', '25'],
    ['null', null],
    ['NaN', Number.NaN],
  ])(
    'ignores %s as a row limit and keeps the runtime option',
    async (_label, limit) => {
      const runtime = fabricSemanticModel({
        target: TARGET,
        resultSetRowCountLimit: 100,
      });
      const http = httpReturning(arrowResponse());

      await runOperation(
        runtime,
        buildContext({
          http,
          input: { query: 'EVALUATE Sales', resultSetRowCountLimit: limit },
        }),
        vi.fn<InvokeNext>()
      );

      expect(bodyOf(http.calls[0])).toEqual({
        query: 'EVALUATE Sales',
        resultSetRowCountLimit: 100,
      });
    }
  );

  it('sends no row limit when neither the input nor the options set one', async () => {
    const runtime = fabricSemanticModel({ target: TARGET });
    const http = httpReturning(arrowResponse());

    await runOperation(runtime, buildContext({ http }), vi.fn<InvokeNext>());

    expect(bodyOf(http.calls[0])).toEqual({ query: 'EVALUATE Sales' });
  });

  // The delegated paths forward the input to BaaS verbatim, so an unusable
  // limit has to be removed before delegation rather than inside the branch
  // that happens to read it. Validating in only one branch would make the
  // documented contract true on the CLI and false everywhere else.
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
    ['a numeric string', '25'],
    ['null', null],
    ['NaN', Number.NaN],
  ])(
    'strips %s from the input delegated to a non-CLI host',
    async (_label, limit) => {
      const next = vi.fn<InvokeNext>().mockResolvedValue('delegated');
      const runtime = fabricSemanticModel({ target: TARGET });

      await runOperation(
        runtime,
        buildContext({
          host: { type: 'standalone' },
          input: { query: 'EVALUATE Sales', resultSetRowCountLimit: limit },
        }),
        next
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0].input).toEqual({ query: 'EVALUATE Sales' });
    }
  );

  it('preserves a usable row limit on the input delegated to a non-CLI host', async () => {
    const next = vi.fn<InvokeNext>().mockResolvedValue('delegated');
    const runtime = fabricSemanticModel({ target: TARGET });

    await runOperation(
      runtime,
      buildContext({
        host: { type: 'standalone' },
        input: { query: 'EVALUATE Sales', resultSetRowCountLimit: 25 },
      }),
      next
    );

    expect(next.mock.calls[0][0].input).toEqual({
      query: 'EVALUATE Sales',
      resultSetRowCountLimit: 25,
    });
  });

  it("does not mutate the caller's context when stripping a limit", async () => {
    const next = vi.fn<InvokeNext>().mockResolvedValue('delegated');
    const runtime = fabricSemanticModel({ target: TARGET });
    const ctx = buildContext({
      host: { type: 'standalone' },
      input: { query: 'EVALUATE Sales', resultSetRowCountLimit: 0 },
    });

    await runOperation(runtime, ctx, next);

    // The context belongs to the connectors layer; editing it in place would
    // change what later hooks observe.
    expect(ctx.input).toEqual({
      query: 'EVALUATE Sales',
      resultSetRowCountLimit: 0,
    });
  });
});

describe('CLI and standalone output parity', () => {
  /**
   * Compare the parts of a result that describe the *data*.
   *
   * `requestId` is deliberately excluded: it describes the transport, not the
   * answer, and only the direct path can generate one client-side. Parity that
   * mattered would be broken by a difference in rows, columns, or error
   * categorisation.
   */
  function semanticPart(result: SemanticModelQueryResult) {
    const { requestId: _id, ...rest } = result as unknown as Record<
      string,
      unknown
    >;
    return rest;
  }

  it('normalises a successful query identically on both paths', async () => {
    const runtime = fabricSemanticModel({ target: TARGET });

    const cli = (await runOperation(
      runtime,
      buildContext({ http: httpReturning(arrowResponse()) }),
      vi.fn<InvokeNext>()
    )) as SemanticModelQueryResult;

    const standalone = (await runOperation(
      runtime,
      buildContext({ host: { type: 'standalone' } }),
      vi.fn<InvokeNext>().mockResolvedValue(arrowStream(SAMPLE_ROWS))
    )) as SemanticModelQueryResult;

    expect(semanticPart(cli)).toEqual(semanticPart(standalone));
    expect(semanticPart(cli)).toEqual({
      status: 'success',
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

  it('normalises a DAX error identically on both paths', async () => {
    // Power BI marks an in-band DAX error with all three columns; `arrow.ts`
    // requires the full set before it will reinterpret a 200 as a failure.
    const errorTable = {
      ErrorCode: ['DaxError'],
      ErrorMessage: ['Query (1, 9) The syntax for Sales is incorrect.'],
      ErrorDescription: ['The syntax for Sales is incorrect.'],
    };
    const runtime = fabricSemanticModel({ target: TARGET });

    const cli = (await runOperation(
      runtime,
      buildContext({ http: httpReturning(arrowResponse(errorTable)) }),
      vi.fn<InvokeNext>()
    )) as SemanticModelQueryResult;

    const standalone = (await runOperation(
      runtime,
      buildContext({ host: { type: 'standalone' } }),
      vi.fn<InvokeNext>().mockResolvedValue(arrowStream(errorTable))
    )) as SemanticModelQueryResult;

    expect(semanticPart(cli)).toEqual(semanticPart(standalone));
    expect(semanticPart(cli)).toEqual({
      status: 'error',
      error: {
        category: 'query',
        message: 'Query (1, 9) The syntax for Sales is incorrect.',
        code: 'DaxError',
        details: 'The syntax for Sales is incorrect.',
      },
    });
  });

  it('carries the Power BI request id on the CLI path', async () => {
    const runtime = fabricSemanticModel({ target: TARGET });

    const cli = (await runOperation(
      runtime,
      buildContext({ http: httpReturning(arrowResponse()) }),
      vi.fn<InvokeNext>()
    )) as SemanticModelQueryResult;

    expect(cli.requestId).toBe('pbi-request-id');
  });

  it('leaves no post-invoke processing for the connectors layer', () => {
    const op = fabricSemanticModel({ target: TARGET }).operations?.executeQuery;

    // The layer runs `decodeBinary` after `invoke`, which is too late for a
    // middleware that decodes in order to normalise. Registering one here
    // would mean the result had to be read differently depending on which
    // transport ran, which is the thing this design removes.
    expect(op?.decodeBinary).toBeUndefined();
    expect(op?.invoke).toBeDefined();
  });

  it('returns the same result shape whether the payload arrives as Arrow or JSON', async () => {
    const runtime = fabricSemanticModel({ target: TARGET });

    const fromArrow = (await runOperation(
      runtime,
      buildContext({ host: { type: 'standalone' } }),
      vi.fn<InvokeNext>().mockResolvedValue(arrowStream(SAMPLE_ROWS))
    )) as SemanticModelQueryResult;

    const fromJson = (await runOperation(
      runtime,
      buildContext({ host: { type: 'standalone' } }),
      vi.fn<InvokeNext>().mockResolvedValue(DELEGATED_RESPONSE)
    )) as SemanticModelQueryResult;

    // Different encodings, same discriminant and the same accessors.
    expect(fromArrow.status).toBe('success');
    expect(fromJson.status).toBe('success');
    if (fromArrow.status !== 'success' || fromJson.status !== 'success') return;
    expect(fromArrow.table.columns.map((c) => c.name)).toEqual([
      'Sales[Region]',
      'Sales[Units]',
    ]);
    expect(fromJson.table.columns.map((c) => c.name)).toEqual([
      'Sales[Region]',
    ]);
  });
});

describe('toQueryResult on an already normalised result', () => {
  it('returns a success result unchanged instead of emptying it', async () => {
    const runtime = fabricSemanticModel({ target: TARGET });
    const result = (await runOperation(
      runtime,
      buildContext({ http: httpReturning(arrowResponse()) }),
      vi.fn<InvokeNext>()
    )) as SemanticModelQueryResult;

    // Callers written against the previous contract still wrap the operation
    // output. Re-normalising would match no error branch and produce a success
    // with zero rows, so the table would silently render blank.
    expect(toQueryResult(result)).toBe(result);
  });

  it('returns an error result unchanged', () => {
    const errorResult: SemanticModelQueryResult = {
      status: 'error',
      error: { category: 'query', message: 'bad DAX' },
      requestId: 'r1',
    };

    expect(toQueryResult(errorResult)).toBe(errorResult);
  });

  it('still normalises a wire envelope whose status reads "Succeeded"', () => {
    // The envelope has its own `status`, so idempotence cannot key off it alone.
    const result = toQueryResult(DELEGATED_RESPONSE);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.table.rows).toHaveLength(1);
    // `requestId` lives under `output` on the wire, so this also pins where
    // normalisation reads it from.
    expect(result.requestId).toBe('delegated-request-id');
  });
});
