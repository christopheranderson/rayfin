import type { CommandRunner } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { describe, expect, it, vi } from 'vitest';

import { createDiagnosticRunner } from '../diagnostic-runner.js';
import { createFunctionsOutputRunner } from '../functions-output.js';

describe('Functions output', () => {
  it('hides host diagnostics but retains endpoints, application logs, warnings and failures', async () => {
    const debug = vi.fn();
    const stdout = vi.fn();
    const stderr = vi.fn();
    const lines = [
      'Azure Functions Core Tools',
      'Core Tools Version: 4.12.1',
      '[2026-09-21T00:00:00.000Z] Building host: version spec: , startup suppressed: False',
      '[2026-09-21T00:00:00.000Z] Host configuration file read:',
      '[2026-09-21T00:00:00.000Z] {',
      '[2026-09-21T00:00:00.000Z]   "version": "2.0",',
      '[2026-09-21T00:00:00.000Z]   "logging": { "logLevel": { "default": "Information" } }',
      '[2026-09-21T00:00:00.000Z] }',
      '[2026-09-21T00:00:00.000Z] Worker process started and initialized.',
      '[2026-09-21T00:00:00.000Z] Worker indexing is enabled',
      '[2026-09-21T00:00:00.000Z] 1 functions found (Worker)',
      'Functions:',
      '    hello: [POST] http://localhost:7073/api/hello',
      '[2026-09-21T00:00:00.000Z] HttpBodyControlOptions',
      '[2026-09-21T00:00:00.000Z] {',
      '[2026-09-21T00:00:00.000Z]   "AllowSynchronousIO": false',
      '[2026-09-21T00:00:00.000Z] }',
      '[2026-09-21T00:00:00.000Z] Application log: request processed',
      '[2026-09-21T00:00:00.000Z] Warning: connection is slow',
      '[2026-09-21T00:00:00.000Z] Function failed: invalid input',
    ];
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.(`${lines.join('\r\n')}\r\n`);
        options?.onStderr?.(
          'Debugger listening on ws://127.0.0.1:9230/session\n'
        );
        options?.onStderr?.('Application stderr');
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    const runner = createFunctionsOutputRunner(
      createDiagnosticRunner({ run }, { debug }),
      true
    );
    await runner.run('func', ['start'], {
      inheritStdio: true,
      onStdout: stdout,
      onStderr: stderr,
    });
    expect(run.mock.calls[0][2]).toMatchObject({
      inheritStdio: false,
      inheritStdin: true,
      captureOutput: false,
    });
    expect(stdout.mock.calls.flat().join('')).toBe(
      'Local functions (Ctrl+C to stop):\n' +
        '  hello: [POST] http://localhost:7073/api/hello\n' +
        '[2026-09-21T00:00:00.000Z] Application log: request processed\n' +
        '[2026-09-21T00:00:00.000Z] Warning: connection is slow\n' +
        '[2026-09-21T00:00:00.000Z] Function failed: invalid input\n'
    );
    expect(stderr.mock.calls.flat()).toEqual([
      'Debugger: 127.0.0.1:9230\n',
      'Application stderr\n',
    ]);
    expect(JSON.stringify(debug.mock.calls)).toContain('AllowSynchronousIO');
    expect(JSON.stringify(debug.mock.calls)).toContain('Building host');
  });

  it('condenses host restarts and hides interleaved restart and bundle detail', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const ts = '[2026-09-26T04:30:24.877Z]';
    const watched = (dir: string) =>
      `${ts} Watched directory change of type 'Changed' detected for '/app/functions/node_modules/${dir}'`;
    const lines = [
      "AZURE_FUNCTIONS_ENVIRONMENT already exists with value 'Development', overriding to 'Development'.",
      "FUNCTIONS_WORKER_RUNTIME already exists with value 'dotnet', overriding to 'node'.",
      "Skipping 'RAYFIN_FABRIC_ITEM_ID' from local settings as it's already defined in current environment variables.",
      `${ts} Applying platform release channel configuration LATEST. Bundle version 4.48.0 will be used`,
      `${ts} Fetching information on versions of extension bundle Microsoft.Azure.Functions.ExtensionBundle.Preview available on https://cdn.functions.azure.com/public/ExtensionBundles/index.json`,
      `${ts} Skipping bundle download since it already exists at path /home/dev/.azure-functions-core-tools/ExtensionBundles/4.48.0`,
      `${ts} Loading startup extension 'Startup'`,
      `${ts} Loaded extension 'Startup' (1.0.110.0)`,
      `${ts} Azure Functions Fabric Extension Version: 1.0.110.0.`,
      watched('@types/node/assert') + `${ts} Executing HTTP request: {`,
      `${ts}   "requestId": "662ceb5e",`,
      `${ts}   "method": "POST",`,
      `${ts}   "userAgent": "node",${ts} Host configuration has changed. Signaling restart`,
      `${ts}   "uri": "/admin/host/ping"`,
      `${ts} }`,
      watched('@azure/msal-common/dist/crypto'),
      `${ts} Host configuration has changed. Signaling restart`,
      `${ts} Restarting host.`,
      `${ts} ScriptHostRecycleOptions`,
      `${ts} Stopping JobHost`,
      `${ts} {`,
      `${ts}   "SequentialHostRestartRequired": true`,
      `${ts} }${ts} Job host stopped`,
      `${ts} Shutting down language worker channels for runtime:node`,
      `${ts} [UserDataFunctions] LanguageWorkerConsoleLogWorker 0281060a-49f5-4746-af76-dd47e1696c75 exited with code 0`,
      `${ts} HttpOptions${ts} Initializing function HTTP routes`,
      `${ts} {`,
      `${ts}   "DynamicThrottlesEnabled": false,`,
      `${ts}   "RoutePrefix": "api"`,
      `${ts} }`,
      `${ts} Host restarted.`,
      `${ts} [UserDataFunctions] LanguageWorkerConsoleLogWorker 8d72f6f2-b230-4d74-85c5-f8d23413c481 exited with code 1`,
      `${ts} Application log before${ts} Application log after`,
      `${ts} Host configuration has changed. Signaling shutdown`,
    ];
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.(`${lines.join('\n')}\n`);
        options?.onStderr?.(
          'Debugger listening on ws://127.0.0.1:9230/first\n'
        );
        options?.onStderr?.(
          'Debugger listening on ws://127.0.0.1:9230/second\n'
        );
        options?.onStderr?.(
          'Debugger listening on ws://127.0.0.1:9231/third\n'
        );
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', ['start'], {
      onStdout: stdout,
      onStderr: stderr,
    });
    expect(stdout.mock.calls.flat()).toEqual([
      "FUNCTIONS_WORKER_RUNTIME already exists with value 'dotnet', overriding to 'node'.\n",
      'Functions host restarted.\n',
      `${ts} [UserDataFunctions] LanguageWorkerConsoleLogWorker 8d72f6f2-b230-4d74-85c5-f8d23413c481 exited with code 1\n`,
      `${ts} Application log before\n`,
      `${ts} Application log after\n`,
      `${ts} Host configuration has changed. Signaling shutdown\n`,
    ]);
    expect(stderr.mock.calls.flat()).toEqual([
      'Debugger: 127.0.0.1:9230\n',
      'Debugger: 127.0.0.1:9231\n',
    ]);
  });

  it('keeps unknown and interleaved messages instead of swallowing failures', async () => {
    const stdout = vi.fn();
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.('LoggerFilterOptions\n{\nError: worker failed\n');
        options?.onStdout?.('CustomOptions\n{"user":"value"}\n');
        options?.onStdout?.('\u001b[31mWarning: token Bear');
        options?.onStdout?.('er private-token\u001b[0m');
        return { launched: true, exitCode: 1, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', [], {
      onStdout: stdout,
    });
    const output = stdout.mock.calls.flat().join('');
    expect(output).toContain('Error: worker failed');
    expect(output).toContain('CustomOptions\n{"user":"value"}');
    expect(output).toContain('Bearer [REDACTED]');
    expect(output).not.toContain('private-token');
    expect(output).not.toContain('\u001b');
  });

  it('retains endpoint announcements interleaved inside configuration records', async () => {
    const stdout = vi.fn();
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.('WorkerConfigurationResolverOptions\n{\n');
        options?.onStdout?.(
          '  "WorkersAvailableForResolution": [],Functions:\n'
        );
        options?.onStdout?.(
          '  "WorkerArguments": null,\tfail: [GET] http://localhost:7072/api/fail\n'
        );
        options?.onStdout?.(
          '  hello: [POST] http://localhost:7072/api/hello\n'
        );
        options?.onStdout?.('  "WorkerIndexing": true\n}\nApplication log\n');
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', [], {
      onStdout: stdout,
    });
    expect(stdout.mock.calls.flat()).toEqual([
      'Local functions (Ctrl+C to stop):\n',
      '  fail: [GET] http://localhost:7072/api/fail\n',
      '  hello: [POST] http://localhost:7072/api/hello\n',
      'Application log\n',
    ]);
  });

  it('bounds incomplete lines and resumes normal output after oversized input', async () => {
    const stdout = vi.fn();
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.('x'.repeat(32 * 1024));
        options?.onStdout?.('\nApplication log\n');
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', [], {
      onStdout: stdout,
    });
    expect(stdout.mock.calls.flat()).toEqual([
      '[Functions output line truncated]\n',
      'Application log\n',
    ]);
  });

  it.each([
    '/workspaces/myapp/rayfin/functions/dist/hello.js:12:5',
    '/home/dev/myapp/rayfin/functions/src/hello.ts:42:9',
    'C:\\Users\\dev\\app\\src\\hello.ts:12:5',
  ])('preserves stack-frame source locations: %s', async (location) => {
    const stdout = vi.fn();
    const line = `    at helloHandler (${location})`;
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.(`${line}\n`);
        return { launched: true, exitCode: 1, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', [], {
      onStdout: stdout,
    });
    expect(stdout).toHaveBeenCalledExactlyOnceWith(`${line}\n`);
  });

  it.each([4_000, 16 * 1024])(
    'preserves a complete %s-byte app line',
    async (length) => {
      const stdout = vi.fn();
      const line = `${'x'.repeat(length - 4)}tail`;
      const run = vi.fn<CommandRunner['run']>(
        async (_command, _args, options) => {
          options?.onStdout?.(line.slice(0, 2_000));
          options?.onStdout?.(`${line.slice(2_000)}\n`);
          return { launched: true, exitCode: 0, stdout: '', stderr: '' };
        }
      );
      await createFunctionsOutputRunner({ run }, true).run('func', [], {
        onStdout: stdout,
      });
      expect(stdout).toHaveBeenCalledExactlyOnceWith(`${line}\n`);
    }
  );

  it('uses an explicit byte bound for multibyte application lines', async () => {
    const stdout = vi.fn();
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.(`${'\u20ac'.repeat(6_000)}\nnext line\n`);
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', [], {
      onStdout: stdout,
    });
    expect(stdout.mock.calls.flat()).toEqual([
      '[Functions output line truncated]\n',
      'next line\n',
    ]);
  });

  it('retains credential and email masking without removing source paths', async () => {
    const stdout = vi.fn();
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.(
          'Bearer fake-token; Password=fake-password; Pwd=fake-pwd; AccountKey=fake-key; SharedAccessKey=fake-shared; api_key=fake-api; dev@example.com\n'
        );
        options?.onStdout?.(
          'https://user:fake-url-secret@example.test/api?token=fake-query /tmp/app/index.ts:8:2\n'
        );
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', [], {
      onStdout: stdout,
    });
    const output = stdout.mock.calls.flat().join('');
    expect(output).not.toContain('fake-');
    expect(output).not.toContain('dev@example.com');
    expect(output).toContain('/tmp/app/index.ts:8:2');
    expect(output).toContain('[REDACTED]');
  });

  it.each(['func', 'FUNC.EXE', 'C:\\Tools\\FUNC.EXE', 'C:\\Tools\\FuNc.CmD'])(
    'captures Functions output for executable %s',
    async (command) => {
      const stdout = vi.fn();
      const run = vi.fn<CommandRunner['run']>(
        async (_command, _args, options) => {
          options?.onStdout?.('Core Tools Version: 4.12.1\nApplication log\n');
          return { launched: true, exitCode: 0, stdout: '', stderr: '' };
        }
      );
      await createFunctionsOutputRunner({ run }, true).run(command, [], {
        inheritStdio: true,
        onStdout: stdout,
      });
      expect(run.mock.calls[0][2]).toMatchObject({
        inheritStdio: false,
        inheritStdin: true,
      });
      expect(stdout).toHaveBeenCalledExactlyOnceWith('Application log\n');
    }
  );

  it('compacts HTTP diagnostics while retaining failed statuses', async () => {
    const stdout = vi.fn();
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.(
          'Executing HTTP request: {\n  "method": "GET",\n  "uri": "/api/hello"\n}\n'
        );
        options?.onStdout?.(
          'Executed HTTP request: {\n  "status": "200",\n  "duration": "30"\n}\n'
        );
        options?.onStdout?.(
          'Executed HTTP request: {\n  "status": "500",\n  "duration": "40"\n}\n'
        );
        options?.onStdout?.(
          'Executing StatusCodeResult, setting HTTP status code 200\n'
        );
        options?.onStdout?.(
          'Executing StatusCodeResult, setting HTTP status code 503\n'
        );
        options?.onStdout?.('Application error details\n');
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', [], {
      onStdout: stdout,
    });
    expect(stdout.mock.calls.flat()).toEqual([
      'Functions HTTP 500 (40ms)\n',
      'Executing StatusCodeResult, setting HTTP status code 503\n',
      'Application error details\n',
    ]);
  });

  it('does not duplicate diagnostic mirroring or contaminate JSON mode', async () => {
    const debug = vi.fn();
    const stdout = vi.fn();
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        options?.onStdout?.(
          'Functions:\nhello: http://localhost:7071/api/hello\n'
        );
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner(
      createDiagnosticRunner({ run }, { debug }),
      false
    ).run('func', [], { onStdout: stdout });
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.stringify(debug.mock.calls)).toContain('http://localhost:7071');
  });

  it('correlates failed responses by request ID without leaking URL queries or credentials', async () => {
    const stdout = vi.fn();
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        const record = (action: string, detail: object) => {
          options?.onStdout?.(
            `${action} HTTP request: ${JSON.stringify(detail, null, 2)}\n`
          );
        };
        record('Executing', {
          requestId: 'first',
          method: 'POST',
          uri: '/api/orders?email=dev@example.com&token=private-query',
        });
        record('Executing', {
          requestId: 'second',
          method: 'GET',
          uri: 'http://user:private-password@localhost:7071/api/items?key=private-key#fragment',
        });
        record('Executed', { requestId: 'second', status: 404, duration: 10 });
        record('Executed', {
          requestId: 'first',
          status: '500',
          duration: '40',
        });
        record('Executed', { requestId: 'first', status: '503', duration: 5 });
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', [], {
      onStdout: stdout,
    });
    expect(stdout.mock.calls.flat()).toEqual([
      'Functions HTTP 404 GET /api/items (10ms)\n',
      'Functions HTTP 500 POST /api/orders (40ms)\n',
      'Functions HTTP 503 (5ms)\n',
    ]);
  });

  it('bounds correlation state for requests that never complete', async () => {
    const stdout = vi.fn();
    const run = vi.fn<CommandRunner['run']>(
      async (_command, _args, options) => {
        for (let index = 0; index < 101; index += 1) {
          options?.onStdout?.(
            `Executing HTTP request: ${JSON.stringify({ requestId: String(index), method: 'GET', uri: `/api/${index}` }, null, 2)}\n`
          );
        }
        options?.onStdout?.(
          `Executed HTTP request: ${JSON.stringify({ requestId: '0', status: 500 }, null, 2)}\n`
        );
        options?.onStdout?.(
          `Executed HTTP request: ${JSON.stringify({ requestId: '100', status: 500 }, null, 2)}\n`
        );
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      }
    );
    await createFunctionsOutputRunner({ run }, true).run('func', [], {
      onStdout: stdout,
    });
    expect(stdout.mock.calls.flat()).toEqual([
      'Functions HTTP 500\n',
      'Functions HTTP 500 GET /api/100\n',
    ]);
  });

  it('leaves other runtime output and terminal policies unchanged', async () => {
    const run = vi.fn<CommandRunner['run']>().mockResolvedValue({
      launched: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    const options = { inheritStdio: true, onStdout: vi.fn() };
    await createFunctionsOutputRunner({ run }, true).run(
      'npm',
      ['run', 'dev'],
      options
    );
    expect(run).toHaveBeenCalledWith('npm', ['run', 'dev'], options);
  });
});
