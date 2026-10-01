import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

/**
 * Encode named columns as an Arrow IPC stream, matching what the semantic-model
 * service returns on the `executeDaxQueries` endpoint. Fixtures go through
 * apache-arrow's own encoder so the connector's decoder runs against real bytes.
 */
function arrowStream(columns: Record<string, unknown[]>): ArrayBuffer {
  const bytes = tableToIPC(
    tableFromArrays(columns as Record<string, never>),
    'stream'
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

let projectRoot: string;
let projectRootError: Error | null = null;

vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: () => {
    if (projectRootError) {
      throw projectRootError;
    }
    return projectRoot;
  },
}));

const mocks = vi.hoisted(() => ({
  getRemoteEndpoint: vi.fn(),
  getActiveDeploymentEnvVars: vi.fn(),
  getRemoteAuthorizationHeader: vi.fn(),
  getRayfinAuth: vi.fn(),
  hasAmbientToken: vi.fn(),
}));

vi.mock('../utils/remote-endpoint-utils.js', () => ({
  getRemoteEndpoint: mocks.getRemoteEndpoint,
  getActiveDeploymentEnvVars: mocks.getActiveDeploymentEnvVars,
  getRemoteAuthorizationHeader: mocks.getRemoteAuthorizationHeader,
}));

// Partial mocks: other symbols in these modules are imported elsewhere in the
// command's dependency graph, so only the seams under test are replaced.
vi.mock('../auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/index.js')>()),
  getRayfinAuth: mocks.getRayfinAuth,
}));

vi.mock('../utils/ambient-env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/ambient-env.js')>()),
  hasAmbientToken: mocks.hasAmbientToken,
}));

import { connectorInvokeCommand } from '../commands/connector/connector-invoke';
import { classifyCliError, CliHandledError } from '../errors.js';

function writeRayfinYml(connectors: unknown[]) {
  mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'rayfin', 'rayfin.yml'),
    stringify({
      id: 'test-project',
      name: 'test-project',
      version: '1.0.0',
      services: { auth: { enabled: true }, data: { enabled: true } },
      connectors,
    })
  );
}

async function runInvoke(args: string[]): Promise<void> {
  (
    connectorInvokeCommand as unknown as {
      _optionValues: Record<string, unknown>;
    }
  )._optionValues = {};
  (
    connectorInvokeCommand as unknown as {
      _optionValueSources: Record<string, unknown>;
    }
  )._optionValueSources = {};

  const parent = new Command('rayfin');
  parent.addCommand(connectorInvokeCommand);
  parent.exitOverride();

  await parent.parseAsync(['node', 'rayfin', 'invoke', ...args]);
}

async function expectInvokeFailure(args: string[], message: string) {
  const error = await runInvoke(args).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(error).toBeInstanceOf(CliHandledError);
  expect(error).toHaveProperty('message', message);
  expect(classifyCliError(error)).toEqual({ status: 'failed', exitCode: 1 });
  // Details belong in command output, not the exception recorded as telemetry.
  expect((error as CliHandledError).originalError).not.toHaveProperty(
    'details'
  );
}

describe('connector invoke', () => {
  let stdoutSpy: any;
  let stderrSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-invoke-test-'));
    projectRootError = null;

    mocks.getRemoteEndpoint.mockReturnValue(
      'https://api.example/workspaces/ws-1/appBackends/item-1'
    );
    mocks.getActiveDeploymentEnvVars.mockReturnValue({
      rayfinItemId: 'item-1',
    });
    mocks.getRemoteAuthorizationHeader.mockResolvedValue('Bearer test-token');

    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn());

    mocks.getRayfinAuth.mockResolvedValue({
      acquireToken: vi
        .fn()
        .mockResolvedValue({ token: 'test-token', expiresOnTimestamp: 0 }),
    });
    mocks.hasAmbientToken.mockReturnValue(false);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.unstubAllGlobals();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('invokes the connector endpoint with operation and JSON input', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array(0), { status: 200 })
    );

    await runInvoke([
      'salesmodel',
      'executeQuery',
      '--input',
      '{"query":"EVALUATE Sales"}',
      '--json',
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toContain(
      '/groups/ws-1/datasets/model-1/executeDaxQueries'
    );
    expect(calledInit).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'EVALUATE Sales' }),
      })
    );

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('"status":"ok"');
    expect(output).toContain('"connector":"salesmodel"');
    expect(output).toContain('"operation":"executeQuery"');
  });

  it('reports the first-deploy rejection with its envelope detail', async () => {
    // The body the deployed BaaS route returns while a freshly created item is
    // still rejecting: HTTP 500 with a workload envelope. The all-zero
    // invocation id means the platform synthesized the failure, not that the
    // function never ran.
    //
    // Command-level rather than a unit test, because the envelope reader was
    // previously only consulted on 2xx and this response fails the `ok` gate
    // first.
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    // This test needs the deployed transport, which requires a recorded API URL
    // and publishable key that the shared `beforeEach` mock does not provide.
    mocks.getActiveDeploymentEnvVars.mockReturnValue({
      rayfinItemId: 'item-1',
      rayfinApiUrl: 'https://capacity.example.invalid/appbackends/item-1/',
      publishableKey: 'pk-test',
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
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
        }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      )
    );

    // `modeError` writes through `console.error`, not `process.stderr.write`,
    // so the shared stderr spy does not see it.
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--transport',
        'deployed',
      ])
    ).rejects.toThrow();

    const stderr = consoleError.mock.calls
      .map((call: unknown[]) => call.map(String).join(' '))
      .join('\n');
    consoleError.mockRestore();

    expect(stderr).toContain('WorkloadException/Unauthorized');
    expect(stderr).toContain('No invocation id was propagated');
  });

  it('reports the envelope detail when a non-semantic connector fails inside a 2xx', async () => {
    // `connector-kusto` reports failure as a top-level `errors[]` with no
    // `output.responseError`, which `readConnectorFailure` claims first. Without
    // reading the envelope there the detail is dropped and the user gets a
    // semantic-model recovery hint on a Kusto query.
    writeRayfinYml([
      {
        name: 'telemetry',
        type: 'kusto',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'kql-1' },
      },
    ]);

    mocks.getActiveDeploymentEnvVars.mockReturnValue({
      rayfinItemId: 'item-1',
      rayfinApiUrl: 'https://capacity.example.invalid/appbackends/item-1/',
      publishableKey: 'pk-test',
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'Failed',
          output: { tables: [] },
          errors: [{ message: 'Request is invalid', code: 'BadRequest' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await expect(
      runInvoke([
        'telemetry',
        'executeQuery',
        '--input',
        '{"query":"Telemetry | take 1"}',
        '--transport',
        'deployed',
      ])
    ).rejects.toThrow();

    const stderr = consoleError.mock.calls
      .map((call: unknown[]) => call.map(String).join(' '))
      .join('\n');
    consoleError.mockRestore();

    expect(stderr).toContain('Request is invalid');
    // Kusto names its code `code`, not `errorCode`.
    expect(stderr).toContain('BadRequest');
    // The uncategorised default talks about semantic models.
    expect(stderr).toContain(
      'Check connector configuration and operation input'
    );
    expect(stderr).not.toContain('semantic model permissions');
  });

  it('matches connector name and operation case-insensitively', async () => {
    writeRayfinYml([
      {
        name: 'daily-semantic',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array(0), { status: 200 })
    );

    await runInvoke([
      'DAILY-Semantic',
      'EXECUTEquery',
      '--input',
      '{"query":"EVALUATE Sales"}',
      '--json',
    ]);

    const [calledUrl, calledInit] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toContain(
      '/groups/ws-1/datasets/model-1/executeDaxQueries'
    );
    expect(calledInit).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'EVALUATE Sales' }),
      })
    );

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('"connector":"daily-semantic"');
    expect(output).toContain('"operation":"executeQuery"');
  });

  it('fails when operation is not allowed for the connector', async () => {
    writeRayfinYml([
      {
        name: 'sales',
        type: 'fabric-sqldatabase',
        operations: [{ name: 'read' }],
        config: { workspaceId: 'ws-1', itemId: 'db-1' },
      },
    ]);

    await expect(
      runInvoke(['sales', 'delete', '--input', '{}'])
    ).rejects.toThrow(
      'Operation "delete" is not allowed for connector "sales" (type=fabric-sqldatabase).'
    );
  });

  it('invokes using --file payload source', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    const inputFile = join(projectRoot, 'invoke-input.json');
    writeFileSync(inputFile, JSON.stringify({ query: 'EVALUATE Sales' }));

    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array(0), { status: 200 })
    );

    await runInvoke([
      'salesmodel',
      'executeQuery',
      '--file',
      'invoke-input.json',
      '--json',
    ]);

    const [calledUrl, calledInit] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toContain(
      '/groups/ws-1/datasets/model-1/executeDaxQueries'
    );
    expect(calledInit).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'EVALUATE Sales' }),
      })
    );
  });

  it('fails when both --input and --file are supplied', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    const inputFile = join(projectRoot, 'invoke-input.json');
    writeFileSync(inputFile, JSON.stringify({ query: 'EVALUATE Sales' }));

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--file',
        'invoke-input.json',
      ])
    ).rejects.toThrow('Choose exactly one payload source.');
  });

  it('fails when neither --input nor --file is supplied', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    await expect(runInvoke(['salesmodel', 'executeQuery'])).rejects.toThrow(
      'Missing payload input.'
    );
  });

  it('quotes the JSON payload hints with single quotes so they are copy-pasteable', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInvoke(['salesmodel', 'executeQuery'])).rejects.toThrow(
      'Missing payload input.'
    );

    const output = errSpy.mock.calls.map((c: any[]) => String(c[0])).join('');
    errSpy.mockRestore();

    expect(output).toContain("--input '<json>'");
    expect(output).not.toContain('--input "<json>"');
  });

  it('shows a shell-safe example when --input is not valid JSON', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runInvoke(['salesmodel', 'executeQuery', '--input', 'not-json'])
    ).rejects.toThrow('Invalid JSON passed to --input.');

    const output = errSpy.mock.calls.map((c: any[]) => String(c[0])).join('');
    errSpy.mockRestore();

    expect(output).toContain(`--input '{"query":"EVALUATE TOPN(10, Sales)"}'`);
    expect(output).not.toContain('--input "{"query"');
  });

  it('uses semantic-model pre-deploy endpoint when no rayfin deployment exists', async () => {
    writeRayfinYml([
      {
        name: 'daily-semantic',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-sem', itemId: 'model-sem' },
      },
    ]);

    mocks.getRemoteEndpoint.mockReturnValue(null);
    mocks.getActiveDeploymentEnvVars.mockReturnValue(null);

    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array(0), { status: 200 })
    );

    await runInvoke([
      'daily-semantic',
      'executeQuery',
      '--input',
      '{"query":"EVALUATE TOPN(1, testmodel)"}',
      '--json',
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toContain(
      '/groups/ws-sem/datasets/model-sem/executeDaxQueries'
    );
    expect(calledInit).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'EVALUATE TOPN(1, testmodel)' }),
      })
    );

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('"status":"ok"');
    expect(output).toContain('"connector":"daily-semantic"');
  });

  it.each(['auto', 'deployed'])(
    'preserves DAX diagnostics over %s transport',
    async (transport) => {
      writeRayfinYml([
        {
          name: 'daily-semantic',
          type: 'fabric-semanticmodel',
          operations: [{ name: 'executeQuery' }],
          config: { workspaceId: 'ws-sem', itemId: 'model-sem' },
        },
      ]);

      mocks.getActiveDeploymentEnvVars.mockReturnValue(
        transport === 'deployed'
          ? {
              rayfinItemId: 'item-1',
              rayfinApiUrl:
                'https://capacity.example.invalid/appbackends/item-1/',
              publishableKey: 'pk-test',
            }
          : null
      );
      if (transport === 'auto') {
        mocks.getRemoteEndpoint.mockReturnValue(null);
      }

      // DAX errors come back in-band on an HTTP 200 with `status: 'Succeeded'`,
      // so nothing about the transport signals failure. The command only spots it
      // because the connector normalises the envelope into a discriminated result.
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          arrowStream({
            ErrorCode: ['DAX_ERROR'],
            ErrorMessage: ["The column 'Foo' could not be found"],
            ErrorDescription: ['Column not found'],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/vnd.apache.arrow.stream',
              requestid: 'req-dax',
            },
          }
        )
      );

      await expectInvokeFailure(
        [
          'daily-semantic',
          'executeQuery',
          '--input',
          '{"query":"EVALUATE Foo"}',
          '--transport',
          transport,
          '--json',
        ],
        "Connector invoke failed (DAX_ERROR): The column 'Foo' could not be found"
      );

      const output = stdoutSpy.mock.calls
        .map((call: unknown[]) => call[0])
        .join('');
      expect(JSON.parse(output)).toEqual({
        status: 'error',
        error:
          "Connector invoke failed (DAX_ERROR): The column 'Foo' could not be found",
        recovery:
          'The service ran the operation and reported an error. Fix the query and retry.',
        requestId: 'req-dax',
        connectorError: {
          category: 'query',
          code: 'DAX_ERROR',
          message: "The column 'Foo' could not be found",
          details: 'Column not found',
        },
      });
    }
  );

  it.each(['queryError', 'responseError', 'normalized'])(
    'preserves structured deployed JSON errors (%s)',
    async (shape) => {
      writeRayfinYml([
        {
          name: 'salesmodel',
          type: 'fabric-semanticmodel',
          operations: [{ name: 'executeQuery' }],
          config: { workspaceId: 'ws-1', itemId: 'model-1' },
        },
      ]);
      mocks.getActiveDeploymentEnvVars.mockReturnValue({
        rayfinItemId: 'item-1',
        rayfinApiUrl: 'https://capacity.example.invalid/appbackends/item-1/',
        publishableKey: 'pk-test',
      });
      const connectorError = {
        message: 'Column not found',
        category: 'query',
        code: 'DAX_ERROR',
        details: 'The column Foo does not exist',
      };
      const suppliedError = {
        ...connectorError,
        recoveryHint: 'Check the column name.',
      };
      const payload =
        shape === 'normalized'
          ? {
              status: 'error',
              error: suppliedError,
              requestId: 'req-embedded',
            }
          : {
              status: 'Succeeded',
              output: {
                tables: [],
                [shape]: suppliedError,
                requestId: 'req-embedded',
              },
              errors: [],
            };
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            requestid: 'req-header',
          },
        })
      );

      await expectInvokeFailure(
        [
          'salesmodel',
          'executeQuery',
          '--input',
          '{"query":"EVALUATE Foo"}',
          '--transport',
          'deployed',
          '--json',
        ],
        'Connector invoke failed (DAX_ERROR): Column not found'
      );

      expect(
        JSON.parse(
          stdoutSpy.mock.calls.map((call: unknown[]) => call[0]).join('')
        )
      ).toEqual({
        status: 'error',
        error: 'Connector invoke failed (DAX_ERROR): Column not found',
        recovery: 'Check the column name.',
        requestId: 'req-embedded',
        connectorError,
      });
    }
  );

  it.each([200, 403])(
    'preserves deployed response errors on HTTP %s with header correlation',
    async (status) => {
      writeRayfinYml([
        {
          name: 'salesmodel',
          type: 'fabric-semanticmodel',
          operations: [{ name: 'executeQuery' }],
          config: { workspaceId: 'ws-1', itemId: 'model-1' },
        },
      ]);
      mocks.getActiveDeploymentEnvVars.mockReturnValue({
        rayfinItemId: 'item-1',
        rayfinApiUrl: 'https://capacity.example.invalid/appbackends/item-1/',
        publishableKey: 'pk-test',
      });
      const connectorError = {
        message: 'Access denied',
        category: 'api',
        code: '403',
        details: 'Build permission is required',
      };
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'Failed',
            output: { tables: [], responseError: connectorError },
            errors: [],
          }),
          {
            status,
            headers: {
              'content-type': 'application/json',
              'x-ms-root-activity-id': 'req-header',
            },
          }
        )
      );
      const message =
        status === 200
          ? 'Connector invoke failed (HTTP 403 Forbidden): Access denied'
          : 'Connector invoke failed (HTTP 403 Forbidden): The workload reported a failed invocation.';

      await expectInvokeFailure(
        [
          'salesmodel',
          'executeQuery',
          '--input',
          '{"query":"EVALUATE Sales"}',
          '--transport',
          'deployed',
          '--json',
        ],
        message
      );

      expect(
        JSON.parse(
          stdoutSpy.mock.calls.map((call: unknown[]) => call[0]).join('')
        )
      ).toEqual({
        status: 'error',
        error: message,
        recovery:
          status === 200
            ? 'The service rejected the request. Confirm you are signed in and have access to the resource.'
            : 'Your identity is authenticated but does not have required permissions for this operation.',
        requestId: 'req-header',
        connectorError,
      });
    }
  );

  it('coerces non-string deployed diagnostics into connectorError', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);
    mocks.getActiveDeploymentEnvVars.mockReturnValue({
      rayfinItemId: 'item-1',
      rayfinApiUrl: 'https://capacity.example.invalid/appbackends/item-1/',
      publishableKey: 'pk-test',
    });
    // The deployed JSON payload is passed through unnormalised, so a connector
    // can hand back a numeric `code` or a structured `details`. They must
    // survive rather than being dropped by a string-only filter.
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'Failed',
          output: {
            tables: [],
            responseError: {
              message: 'Access denied',
              category: 'api',
              code: 5024,
              details: { table: 'Foo', missing: true },
            },
          },
          errors: [],
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-ms-root-activity-id': 'req-header',
          },
        }
      )
    );

    await expectInvokeFailure(
      [
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--transport',
        'deployed',
        '--json',
      ],
      'Connector invoke failed (HTTP 403 Forbidden): The workload reported a failed invocation.'
    );

    const parsed = JSON.parse(
      stdoutSpy.mock.calls.map((call: unknown[]) => call[0]).join('')
    );
    expect(parsed.connectorError).toEqual({
      message: 'Access denied',
      category: 'api',
      code: '5024',
      details: '{"table":"Foo","missing":true}',
    });
  });

  it('omits empty deployed diagnostics on the unnormalised passthrough', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);
    mocks.getActiveDeploymentEnvVars.mockReturnValue({
      rayfinItemId: 'item-1',
      rayfinApiUrl: 'https://capacity.example.invalid/appbackends/item-1/',
      publishableKey: 'pk-test',
    });
    // The deployed passthrough is unnormalised, so a connector can hand back
    // empty `code`/`details`. They must be dropped, not surfaced as `''`, to
    // match the SDK path and the documented contract.
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'Failed',
          output: {
            tables: [],
            responseError: {
              message: 'Access denied',
              category: 'api',
              code: '',
              details: '',
            },
          },
          errors: [],
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-ms-root-activity-id': 'req-header',
          },
        }
      )
    );

    await expectInvokeFailure(
      [
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--transport',
        'deployed',
        '--json',
      ],
      'Connector invoke failed (HTTP 403 Forbidden): The workload reported a failed invocation.'
    );

    const parsed = JSON.parse(
      stdoutSpy.mock.calls.map((call: unknown[]) => call[0]).join('')
    );
    expect(parsed.connectorError).toEqual({
      message: 'Access denied',
      category: 'api',
    });
  });

  it('keeps non-semantic JSON failures connector-neutral without fabricated fields', async () => {
    writeRayfinYml([
      {
        name: 'telemetry',
        type: 'kusto',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'kql-1' },
      },
    ]);
    mocks.getActiveDeploymentEnvVars.mockReturnValue({
      rayfinItemId: 'item-1',
      rayfinApiUrl: 'https://capacity.example.invalid/appbackends/item-1/',
      publishableKey: 'pk-test',
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'Failed',
          errors: [{ message: 'Invalid query' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            requestid: 'req-kusto',
          },
        }
      )
    );

    await expectInvokeFailure(
      [
        'telemetry',
        'executeQuery',
        '--input',
        '{"query":"invalid"}',
        '--transport',
        'deployed',
        '--json',
      ],
      'Connector invoke failed (connector error): Invalid query'
    );

    expect(
      JSON.parse(
        stdoutSpy.mock.calls.map((call: unknown[]) => call[0]).join('')
      )
    ).toEqual({
      status: 'error',
      error: 'Connector invoke failed (connector error): Invalid query',
      recovery:
        'Check connector configuration and operation input, then retry with --verbose.',
      requestId: 'req-kusto',
      connectorError: {
        message: 'Invalid query',
      },
    });
  });

  it('fails when a result value overflows the Arrow decoder', async () => {
    writeRayfinYml([
      {
        name: 'daily-semantic',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-sem', itemId: 'model-sem' },
      },
    ]);

    mocks.getRemoteEndpoint.mockReturnValue(null);
    mocks.getActiveDeploymentEnvVars.mockReturnValue(null);

    // Overflow is reported as a per-table error, also on a `Succeeded` envelope.
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        arrowStream({
          BigValue: [BigInt(Number.MAX_SAFE_INTEGER) + BigInt(10)],
        }),
        { status: 200 }
      )
    );

    await expect(
      runInvoke([
        'daily-semantic',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE BigTable"}',
        '--json',
      ])
    ).rejects.toThrow('Connector invoke failed (connector error)');

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('"status":"error"');
    expect(output).toContain('exceeds Number.MAX_SAFE_INTEGER');
  });

  it('emits the connector-normalised result on success', async () => {
    writeRayfinYml([
      {
        name: 'daily-semantic',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-sem', itemId: 'model-sem' },
      },
    ]);

    mocks.getRemoteEndpoint.mockReturnValue(null);
    mocks.getActiveDeploymentEnvVars.mockReturnValue(null);

    vi.mocked(fetch).mockResolvedValue(
      new Response(arrowStream({ Amount: [1] }), { status: 200 })
    );

    await runInvoke([
      'daily-semantic',
      'executeQuery',
      '--input',
      '{"query":"EVALUATE Sales"}',
      '--json',
    ]);

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    const parsed = JSON.parse(output) as {
      status: string;
      output: {
        status: string;
        table?: { columns: { name: string }[]; rows: unknown[][] };
      };
    };

    // The payload is the connector's own normalised shape, so this command and
    // an app reading the operation result agree on what a result looks like.
    expect(parsed.status).toBe('ok');
    expect(parsed.output.status).toBe('success');
    expect(parsed.output.table?.columns.map((column) => column.name)).toEqual([
      'Amount',
    ]);
    expect(parsed.output.table?.rows).toEqual([[1]]);
  });

  it('spills an oversized result to a file and previews it in the envelope', async () => {
    writeRayfinYml([
      {
        name: 'daily-semantic',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-sem', itemId: 'model-sem' },
      },
    ]);

    mocks.getRemoteEndpoint.mockReturnValue(null);
    mocks.getActiveDeploymentEnvVars.mockReturnValue(null);

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        arrowStream({
          Note: Array.from({ length: 500 }, () => 'x'.repeat(200)),
        }),
        { status: 200 }
      )
    );

    await runInvoke([
      'daily-semantic',
      'executeQuery',
      '--input',
      '{"query":"EVALUATE Sales"}',
      '--max-inline-bytes',
      '8000',
      '--json',
    ]);
    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    const parsed = JSON.parse(output) as {
      status: string;
      outputFile: string;
      outputBytes: number;
      outputTruncated: boolean;
      output: { table: { rows: unknown[][] } };
    };

    // Still exactly one JSON object, now carrying a pointer a caller can detect.
    expect(parsed.status).toBe('ok');
    expect(parsed.outputTruncated).toBe(true);
    // Spilled inside the project's gitignored scratch area, not the user home.
    expect(parsed.outputFile).toContain(
      join('rayfin', '.temp', 'invoke-results')
    );
    expect(parsed.outputBytes).toBeGreaterThan(8000);
    expect(parsed.output.table.rows).toHaveLength(20);

    // The terminal saw a preview; the file has everything.
    const written = JSON.parse(readFileSync(parsed.outputFile, 'utf8')) as {
      table: { rows: unknown[][] };
    };
    expect(written.table.rows).toHaveLength(500);
  });

  it('writes the full result to an explicit --output-file without truncating', async () => {
    writeRayfinYml([
      {
        name: 'daily-semantic',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-sem', itemId: 'model-sem' },
      },
    ]);

    mocks.getRemoteEndpoint.mockReturnValue(null);
    mocks.getActiveDeploymentEnvVars.mockReturnValue(null);

    vi.mocked(fetch).mockResolvedValue(
      new Response(arrowStream({ Amount: [1] }), { status: 200 })
    );

    const target = join(projectRoot, 'result.json');
    await runInvoke([
      'daily-semantic',
      'executeQuery',
      '--input',
      '{"query":"EVALUATE Sales"}',
      '--output-file',
      target,
      '--json',
    ]);

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    const parsed = JSON.parse(output) as {
      outputFile: string;
      outputTruncated?: boolean;
      output: { table: { rows: unknown[][] } };
    };

    expect(parsed.outputFile).toBe(target);
    expect(parsed.outputTruncated).toBeUndefined();
    expect(parsed.output.table.rows).toEqual([[1]]);
    expect(
      (JSON.parse(readFileSync(target, 'utf8')) as typeof parsed.output).table
        .rows
    ).toEqual([[1]]);
  });

  it('rejects a --max-inline-bytes value that is not a byte count', async () => {
    writeRayfinYml([
      {
        name: 'daily-semantic',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-sem', itemId: 'model-sem' },
      },
    ]);

    await expectInvokeFailure(
      [
        'daily-semantic',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--max-inline-bytes',
        '-1',
        '--json',
      ],
      'Invalid --max-inline-bytes value: -1.'
    );
  });

  it('surfaces a permission hint when the semantic model rejects the token', async () => {
    writeRayfinYml([
      {
        name: 'daily-semantic',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-sem', itemId: 'model-sem' },
      },
    ]);

    mocks.getRemoteEndpoint.mockReturnValue(null);
    mocks.getActiveDeploymentEnvVars.mockReturnValue(null);

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'PowerBINotAuthorizedException',
            message: 'API is not accessible for application',
          },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    await expect(
      runInvoke([
        'daily-semantic',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE TOPN(1, testmodel)"}',
        '--json',
      ])
    ).rejects.toThrow(
      'Connector invoke failed (PowerBINotAuthorizedException): API is not accessible for application'
    );

    expect(fetch).toHaveBeenCalledTimes(1);

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('"status":"error"');
    expect(output).toContain('at least Viewer access');
  });

  it('still requires rayfin up for non-semantic connectors when deployment is missing', async () => {
    writeRayfinYml([
      {
        name: 'sales-db',
        type: 'fabric-sqldatabase',
        operations: [{ name: 'read' }],
        config: { workspaceId: 'ws-db', itemId: 'db-item' },
      },
    ]);

    mocks.getRemoteEndpoint.mockReturnValue(null);
    mocks.getActiveDeploymentEnvVars.mockReturnValue(null);

    await expect(
      runInvoke(['sales-db', 'read', '--input', '{}'])
    ).rejects.toThrow('No remote endpoint configured.');
  });

  it('emits a user-friendly recovery hint for 401 responses', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'HTTP 401' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow(
      'Connector invoke failed (HTTP 401 Unauthorized): {"error":"HTTP 401"}'
    );

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('at least Viewer access');
  });

  it('does not blame workspace access for a 401 with an empty body', async () => {
    // AB#2247879. The CLI used to match `401` out of the error code and print
    // the permissions hint regardless, which sent developers auditing access
    // that was never the problem. The connector now supplies the hint, and
    // the CLI has to prefer it over anything it would derive itself.
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 401 }));

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow('Power BI returned HTTP 401 with an empty body.');

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('check the token first');
    expect(output).toContain('https://analysis.windows.net/powerbi/api');
    expect(output).not.toContain('at least Viewer access');
  });

  it('derives the recovery hint from the error category', async () => {
    // A 502 is not an auth failure, so the hint has to come from the
    // category the connector set rather than from matching the message.
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>Bad Gateway</html>', { status: 502 })
    );

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow('Bad Gateway');

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('The service rejected the request');
    expect(output).not.toContain('at least Viewer access');
  });

  it('fails when the semantic-model connector is missing workspaceId/itemId', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
      },
    ]);

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow(
      'Connector "salesmodel" is missing workspaceId/itemId in rayfin.yml.'
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects --verbose combined with --json', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--verbose',
        '--json',
      ])
    ).rejects.toThrow('Cannot combine --verbose with --json.');

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('use --output plain');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('writes a string payload unquoted to stdout and the status line to stderr in plain mode', async () => {
    writeRayfinYml([
      {
        name: 'sales',
        type: 'fabric-sqldatabase',
        operations: [{ name: 'read' }],
        config: { workspaceId: 'ws-1', itemId: 'db-1' },
      },
    ]);

    vi.mocked(fetch).mockResolvedValue(
      new Response('ready', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runInvoke(['sales', 'read', '--input', '{}', '--output', 'plain']);

      const stdout = logSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('\n');
      const stderr = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('');

      // The payload is the only thing on stdout, so `--output plain` stays pipeable.
      expect(stdout).toContain('ready');
      expect(stdout).not.toContain('"ready"');
      expect(stdout).not.toContain('Invoked sales.read');

      // The status line is diagnostics, so it belongs on stderr.
      expect(stderr).toContain('Invoked sales.read');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('keeps JSON quoting on a string payload in interactive mode', async () => {
    writeRayfinYml([
      {
        name: 'sales',
        type: 'fabric-sqldatabase',
        operations: [{ name: 'read' }],
        config: { workspaceId: 'ws-1', itemId: 'db-1' },
      },
    ]);

    vi.mocked(fetch).mockResolvedValue(
      new Response('ready', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runInvoke([
        'sales',
        'read',
        '--input',
        '{}',
        '--output',
        'interactive',
      ]);

      const logged = logSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('\n');
      // Interactive keeps the JSON quoting on a string payload for back-compat.
      expect(logged).toContain('"ready"');
      expect(logged).toContain('Invoked sales.read');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports a project-root lookup failure as a handled error', async () => {
    projectRootError = new Error('Rayfin project root not found');

    await expect(
      runInvoke(['salesmodel', 'executeQuery', '--input', '{}', '--json'])
    ).rejects.toThrow('Rayfin project root not found');

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('error');
    expect(parsed.recovery).toContain(
      'Run this command from inside a Rayfin project'
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces the service requestId on failures', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'HTTP 401' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          requestid: 'req-abc-123',
        },
      })
    );

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow('Connector invoke failed');

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(JSON.parse(output).requestId).toBe('req-abc-123');
  });

  it('fails fast when the access token has the wrong audience', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    const wrongAudience =
      'Bearer x.' +
      Buffer.from(
        JSON.stringify({ aud: 'https://management.azure.com/' })
      ).toString('base64url') +
      '.y';
    mocks.hasAmbientToken.mockReturnValue(true);
    mocks.getRemoteAuthorizationHeader.mockResolvedValue(wrongAudience);

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow('wrong audience');

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('RAYFIN_TOKEN');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails with a sign-in hint when there is no session', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    mocks.hasAmbientToken.mockReturnValue(false);
    mocks.getRayfinAuth.mockResolvedValue({
      acquireToken: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Silent token acquisition failed and interactive login was not allowed'
          )
        ),
    });

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow('Not signed in');

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(JSON.parse(output).recovery).toContain('Re-run without `--json`');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an ambient token whose audience cannot be decoded', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    mocks.hasAmbientToken.mockReturnValue(true);
    mocks.getRemoteAuthorizationHeader.mockResolvedValue(
      'Bea' + 'rer opaque-not-a-jwt'
    );

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow('could not be decoded');

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('RAYFIN_TOKEN');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails cleanly when a cached account cannot mint a Power BI token silently', async () => {
    writeRayfinYml([
      {
        name: 'salesmodel',
        type: 'fabric-semanticmodel',
        operations: [{ name: 'executeQuery' }],
        config: { workspaceId: 'ws-1', itemId: 'model-1' },
      },
    ]);

    // A cached account exists, but the Power BI scope still needs consent, so a
    // silent acquisition fails. The command must not fall back to an
    // interactive prompt that would write non-JSON text to stdout.
    mocks.hasAmbientToken.mockReturnValue(false);
    const acquireToken = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Silent token acquisition failed and interactive login was not allowed'
        )
      );
    mocks.getRayfinAuth.mockResolvedValue({ acquireToken });

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow('without an interactive prompt');

    expect(acquireToken).toHaveBeenCalledWith(expect.anything(), {
      silentOnly: true,
    });

    const output = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('error');
    expect(parsed.recovery).toContain('Re-run without `--json`');
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('Power BI audience resolution', () => {
    const originalFabricApiUrl = process.env.RAYFIN_FABRIC_API_URL;

    afterEach(() => {
      if (originalFabricApiUrl === undefined) {
        delete process.env.RAYFIN_FABRIC_API_URL;
      } else {
        process.env.RAYFIN_FABRIC_API_URL = originalFabricApiUrl;
      }
    });

    /**
     * Drives the command far enough to observe the scopes it asks for, then
     * lets silent acquisition fail so nothing reaches the network.
     */
    async function expectRequestedScopes(expected: string[]) {
      writeRayfinYml([
        {
          name: 'salesmodel',
          type: 'fabric-semanticmodel',
          operations: [{ name: 'executeQuery' }],
          config: { workspaceId: 'ws-1', itemId: 'model-1' },
        },
      ]);

      mocks.hasAmbientToken.mockReturnValue(false);
      const acquireToken = vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Silent token acquisition failed and interactive login was not allowed'
          )
        );
      mocks.getRayfinAuth.mockResolvedValue({ acquireToken });

      await expect(
        runInvoke([
          'salesmodel',
          'executeQuery',
          '--input',
          '{"query":"EVALUATE Sales"}',
          '--json',
        ])
      ).rejects.toThrow('without an interactive prompt');

      expect(acquireToken).toHaveBeenCalledWith(expected, { silentOnly: true });
      expect(fetch).not.toHaveBeenCalled();
    }

    it('uses the production Power BI audience for the default Fabric endpoint', async () => {
      delete process.env.RAYFIN_FABRIC_API_URL;

      await expectRequestedScopes([
        'https://analysis.windows.net/powerbi/api/.default',
      ]);
    });

    it('uses the production Power BI audience for the daily ring', async () => {
      // daily, dxt and msit are separate deployments with their own endpoints,
      // but they are first-production rings hosted under fabric.microsoft.com
      // and their Power BI endpoint validates the public resource audience.
      process.env.RAYFIN_FABRIC_API_URL =
        'https://dailyapi.fabric.microsoft.com';

      await expectRequestedScopes([
        'https://analysis.windows.net/powerbi/api/.default',
      ]);
    });

    it('uses the production Power BI audience for a root-anchored Fabric FQDN', async () => {
      // normalizeFabricApiUrl builds from URL.origin, which preserves a
      // trailing dot, so a root-anchored FQDN survives normalization and has
      // to resolve the same way as its dotless form.
      process.env.RAYFIN_FABRIC_API_URL =
        'https://dailyapi.fabric.microsoft.com./v1';

      await expectRequestedScopes([
        'https://analysis.windows.net/powerbi/api/.default',
      ]);
    });

    it('uses the INT Power BI audience for a pre-production Fabric ring', async () => {
      process.env.RAYFIN_FABRIC_API_URL =
        'https://powerbiapi.analysis-df.windows.net/v1';

      await expectRequestedScopes([
        'https://analysis.windows-int.net/powerbi/api/.default',
      ]);
    });

    it('uses the INT Power BI audience for a custom reverse-proxy endpoint', async () => {
      // getFabricSettings permits arbitrary proxy URLs; anything that is not the
      // canonical production host is treated as non-production on purpose, so we
      // never mint a production-scoped token against an unknown origin.
      process.env.RAYFIN_FABRIC_API_URL =
        'https://my-proxy.example.com/cli-proxy/fabric';

      await expectRequestedScopes([
        'https://analysis.windows-int.net/powerbi/api/.default',
      ]);
    });

    it('uses the INT Power BI audience for the bare fabric.microsoft.com apex', async () => {
      // The apex is the portal, not an API ring, so it is excluded from the
      // shared Fabric host predicate and falls back to the -int resource.
      process.env.RAYFIN_FABRIC_API_URL = 'https://fabric.microsoft.com/v1';

      await expectRequestedScopes([
        'https://analysis.windows-int.net/powerbi/api/.default',
      ]);
    });
  });
});
