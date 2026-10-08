import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

/**
 * Category handling lives in its own file because it replaces the connector
 * runtime wholesale. The failures under test are ones no shipped connector can
 * produce today: `category` crosses a JSON boundary typed as `string`, so the
 * CLI has to survive a value the contract does not define.
 */

let projectRoot: string;
let invokeResult: unknown;
let invokeThrows: boolean;

vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: () => projectRoot,
}));

const mocks = vi.hoisted(() => ({
  getRemoteEndpoint: vi.fn(),
  getActiveDeploymentEnvVars: vi.fn(),
  getRemoteAuthorizationHeader: vi.fn(),
  getRayfinAuth: vi.fn(),
  hasAmbientToken: vi.fn(),
  fabricSemanticModel: vi.fn(),
}));

vi.mock('../utils/remote-endpoint-utils.js', () => ({
  getRemoteEndpoint: mocks.getRemoteEndpoint,
  getActiveDeploymentEnvVars: mocks.getActiveDeploymentEnvVars,
  getRemoteAuthorizationHeader: mocks.getRemoteAuthorizationHeader,
}));

vi.mock('../auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/index.js')>()),
  getRayfinAuth: mocks.getRayfinAuth,
}));

vi.mock('../utils/ambient-env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/ambient-env.js')>()),
  hasAmbientToken: mocks.hasAmbientToken,
}));

vi.mock(
  '@microsoft/rayfin-connector-fabric-semanticmodel',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@microsoft/rayfin-connector-fabric-semanticmodel')
    >()),
    fabricSemanticModel: mocks.fabricSemanticModel,
  })
);

import { connectorInvokeCommand } from '../commands/connector/connector-invoke';
import { classifyCliError, CliHandledError } from '../errors.js';

function writeRayfinYml() {
  mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'rayfin', 'rayfin.yml'),
    stringify({
      id: 'test-project',
      name: 'test-project',
      version: '1.0.0',
      services: { auth: { enabled: true }, data: { enabled: true } },
      connectors: [
        {
          name: 'salesmodel',
          type: 'fabric-semanticmodel',
          operations: [{ name: 'executeQuery' }],
          config: { workspaceId: 'ws-1', itemId: 'model-1' },
        },
      ],
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

describe('connector invoke recovery hints', () => {
  // Structurally typed rather than using vitest's `MockInstance`, whose
  // overloaded `process.stdout.write` signature does not narrow cleanly.
  let stdoutSpy: {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    invokeThrows = false;
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-invoke-category-'));
    writeRayfinYml();

    mocks.getRemoteEndpoint.mockReturnValue(
      'https://api.example/workspaces/ws-1/appBackends/item-1'
    );
    mocks.getActiveDeploymentEnvVars.mockReturnValue({
      rayfinItemId: 'item-1',
    });
    mocks.getRemoteAuthorizationHeader.mockResolvedValue('Bearer test-token');
    mocks.getRayfinAuth.mockResolvedValue({
      acquireToken: vi
        .fn()
        .mockResolvedValue({ token: 'test-token', expiresOnTimestamp: 0 }),
    });
    mocks.hasAmbientToken.mockReturnValue(false);

    // Stand in for the real runtime so the test controls the error the CLI
    // renders. Everything downstream of `invoke` is the shipped code path.
    mocks.fabricSemanticModel.mockReturnValue({
      operations: {
        executeQuery: {
          invoke: () =>
            invokeThrows
              ? Promise.reject(invokeResult)
              : Promise.resolve(invokeResult),
        },
      },
    });

    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function invokeAndReadOutput(error: unknown): Promise<string> {
    invokeResult = { status: 'error', error };

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Sales"}',
        '--json',
      ])
    ).rejects.toThrow();

    return stdoutSpy.mock.calls.map((call: unknown[]) => call[0]).join('');
  }

  it('renders the hint for a category the contract defines', async () => {
    const output = await invokeAndReadOutput({
      message: 'The result exceeded the row cap.',
      category: 'overflow',
    });

    expect(output).toContain('The result exceeded a size cap');
    expect(output).toContain('resultSetRowCountLimit');
  });

  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
    'falls back to the generic hint for the inherited property %s',
    async (category) => {
      // A prototype-chain lookup would resolve these to a function rather than
      // a hint string, so the rendered recovery text has to be the fallback.
      const output = await invokeAndReadOutput({
        message: 'Something went wrong.',
        category,
      });

      expect(output).toContain(
        'Check semantic model permissions and query syntax'
      );
      expect(output).not.toContain('function');
      expect(output).not.toContain('[native code]');
    }
  );

  it('prefers a connector-supplied recovery hint over the category', async () => {
    const output = await invokeAndReadOutput({
      message: 'Power BI returned HTTP 401 with an empty body.',
      category: 'api',
      recoveryHint: 'Check the token audience first.',
    });

    expect(output).toContain('Check the token audience first.');
    expect(output).not.toContain('The service rejected the request');
  });

  it.each([false, true])(
    'preserves only structured connector fields (thrown: %s)',
    async (thrown) => {
      invokeThrows = thrown;
      const connectorError = {
        message: 'Column not found',
        category: 'query',
        code: 'DAX_ERROR',
        details: 'The column Foo does not exist',
      };
      invokeResult = {
        status: 'error',
        requestId: 'req-direct',
        error: {
          ...connectorError,
          recoveryHint: 'Check the column name.',
          internalContext: 'must not be serialized',
        },
      };

      const error = await runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Foo"}',
        '--json',
      ]).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(CliHandledError);
      expect(classifyCliError(error)).toEqual({
        status: 'failed',
        exitCode: 1,
      });
      expect((error as CliHandledError).originalError).not.toHaveProperty(
        'details'
      );
      expect(
        JSON.parse(stdoutSpy.mock.calls.map((call) => call[0]).join(''))
      ).toEqual({
        status: 'error',
        error: 'Connector invoke failed (DAX_ERROR): Column not found',
        requestId: 'req-direct',
        recovery: 'Check the column name.',
        connectorError,
      });
    }
  );

  it('omits optional fields when the connector supplies only a message', async () => {
    const output = await invokeAndReadOutput({ message: 'Query failed' });

    expect(JSON.parse(output)).toEqual({
      status: 'error',
      error: 'Connector invoke failed (connector error): Query failed',
      recovery:
        'Check semantic model permissions and query syntax, then retry with --verbose.',
      connectorError: { message: 'Query failed' },
    });
  });

  it('does not add connector metadata to unrelated exceptions', async () => {
    invokeThrows = true;
    invokeResult = new Error('Unexpected failure');

    await expect(
      runInvoke([
        'salesmodel',
        'executeQuery',
        '--input',
        '{"query":"EVALUATE Foo"}',
        '--json',
      ])
    ).rejects.toThrow('Connector invoke failed: Unexpected failure');

    expect(
      JSON.parse(stdoutSpy.mock.calls.map((call) => call[0]).join(''))
    ).toEqual({
      status: 'error',
      error: 'Connector invoke failed: Unexpected failure',
      recovery:
        'Check semantic model permissions and query syntax, then retry with --verbose.',
    });
  });

  it('survives a circular reference in thrown connector details', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    invokeThrows = true;
    invokeResult = {
      status: 'Failed',
      output: {
        responseError: {
          message: 'boom',
          category: 'query',
          details: circular,
        },
      },
    };

    const error = await runInvoke([
      'salesmodel',
      'executeQuery',
      '--input',
      '{"query":"EVALUATE Foo"}',
      '--json',
    ]).catch((error: unknown) => error);

    // A circular `details` must not turn the handler itself into an unhandled
    // crash; it degrades to a `String()` fallback and the exit stays clean.
    expect(error).toBeInstanceOf(CliHandledError);
    expect(classifyCliError(error)).toEqual({ status: 'failed', exitCode: 1 });

    const parsed = JSON.parse(
      stdoutSpy.mock.calls.map((call) => call[0]).join('')
    );
    expect(parsed.error).toContain('boom');
    expect(parsed.connectorError.message).toBe('boom');
    expect(parsed.connectorError.details).toBe('[object Object]');
  });
});
