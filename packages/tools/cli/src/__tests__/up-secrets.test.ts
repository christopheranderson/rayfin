import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { secretCommand } from '../commands/secret.js';
import { CliHandledError } from '../errors.js';
import { HttpError } from '../utils/retry-utils.js';

const mocks = vi.hoisted(() => ({
  getAuthenticatedToken: vi.fn<() => Promise<{ token: string }>>(),
  getSecretsFromRemoteEndpoint:
    vi.fn<
      () => Promise<
        Array<{ name: string; createdAt: string; updatedAt: string }>
      >
    >(),
  applySecretsToRemoteEndpoint: vi.fn<
    () => Promise<
      Array<{
        id: string;
        name: string;
        createdAt: string;
        updatedAt: string;
      }>
    >
  >(),
  deleteSecretFromRemoteEndpoint: vi.fn<() => Promise<void>>(),
  hasRemoteEndpoint: vi.fn<() => boolean>(),
  getRemoteEndpoint: vi.fn<() => string | undefined>(),
  prompt: vi.fn<
    (
      questions: Array<{
        type: string;
        name: string;
        message: string;
        mask?: string;
      }>
    ) => Promise<{ secretValue?: string; confirm?: boolean }>
  >(),
  upsertSecretMetadata:
    vi.fn<
      (
        secretName: string,
        startPath?: string,
        description?: string
      ) => { status: 'added' | 'exists' | 'skipped' }
    >(),
  removeSecretMetadata:
    vi.fn<
      (
        secretName: string,
        startPath?: string
      ) => { status: 'removed' | 'not-found' | 'skipped' }
    >(),
  generateSecretsTypes: vi.fn<
    (startPath?: string) => {
      status: 'written' | 'unchanged' | 'skipped';
    }
  >(),
}));

vi.mock('../auth/index.js', () => ({
  getAuthenticatedToken: mocks.getAuthenticatedToken,
}));

vi.mock('../services/fabric/rayfin-item.js', () => ({
  getSecretsFromRemoteEndpoint: mocks.getSecretsFromRemoteEndpoint,
  applySecretsToRemoteEndpoint: mocks.applySecretsToRemoteEndpoint,
  deleteSecretFromRemoteEndpoint: mocks.deleteSecretFromRemoteEndpoint,
}));

vi.mock('../utils/remote-endpoint-utils.js', () => ({
  hasRemoteEndpoint: mocks.hasRemoteEndpoint,
  getRemoteEndpoint: mocks.getRemoteEndpoint,
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: mocks.prompt,
  },
}));

vi.mock('../utils/config-utils.js', () => ({
  upsertSecretMetadata: mocks.upsertSecretMetadata,
  removeSecretMetadata: mocks.removeSecretMetadata,
}));

vi.mock('../utils/secrets-types-generator.js', () => ({
  generateSecretsTypes: mocks.generateSecretsTypes,
}));

interface CommanderInternals {
  _optionValues: Record<string, unknown>;
  _optionValueSources: Record<string, unknown>;
  processedArgs: unknown[];
  rawArgs: unknown[];
  args: unknown[];
}

function resetCommandTree(command: Command): void {
  const internals = command as unknown as CommanderInternals;
  internals._optionValues = {};
  internals._optionValueSources = {};
  internals.processedArgs = [];
  internals.rawArgs = [];
  internals.args = [];

  for (const child of command.commands) {
    resetCommandTree(child);
  }
}

function makeRoot(): Command {
  resetCommandTree(secretCommand);
  const root = new Command('rayfin')
    .exitOverride()
    .option('--json', 'Emit machine-readable JSON output', false);
  root.addCommand(secretCommand);
  return root;
}

function getErrorLines(): string[] {
  return (
    (console.error as unknown as { mock?: { calls: unknown[][] } }).mock
      ?.calls ?? []
  )
    .flat()
    .map((value) => String(value));
}

describe('rayfin secret', () => {
  let originalIsTtyDescriptor: PropertyDescriptor | undefined;
  let originalAsyncIteratorDescriptor: PropertyDescriptor | undefined;
  let originalCi: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.hasRemoteEndpoint.mockReturnValue(true);
    mocks.getRemoteEndpoint.mockReturnValue('https://example.invalid/item');
    mocks.getAuthenticatedToken.mockResolvedValue({ token: 'token-123' });

    mocks.applySecretsToRemoteEndpoint.mockResolvedValue([
      {
        id: 'sec-1',
        name: 'API_KEY',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      },
    ]);

    mocks.getSecretsFromRemoteEndpoint.mockResolvedValue([
      {
        name: 'API_KEY',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T01:00:00.000Z',
      },
    ]);

    mocks.prompt.mockResolvedValue({ secretValue: 'super-secret' });
    mocks.upsertSecretMetadata.mockReturnValue({ status: 'added' });
    mocks.removeSecretMetadata.mockReturnValue({ status: 'removed' });
    mocks.generateSecretsTypes.mockReturnValue({ status: 'written' });
    mocks.deleteSecretFromRemoteEndpoint.mockResolvedValue(undefined);

    originalIsTtyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isTTY'
    );
    originalAsyncIteratorDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      Symbol.asyncIterator
    );
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    originalCi = process.env.CI;
    delete process.env.CI;

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalIsTtyDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTtyDescriptor);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    if (originalAsyncIteratorDescriptor) {
      Object.defineProperty(
        process.stdin,
        Symbol.asyncIterator,
        originalAsyncIteratorDescriptor
      );
    } else {
      delete (process.stdin as { [Symbol.asyncIterator]?: unknown })[
        Symbol.asyncIterator
      ];
    }
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  it('registers set and list subcommands with secret set stdin and env-file options', () => {
    expect(secretCommand.name()).toBe('secret');

    const setCommand = secretCommand.commands.find(
      (cmd) => cmd.name() === 'set'
    );
    const listCommand = secretCommand.commands.find(
      (cmd) => cmd.name() === 'list'
    );

    expect(setCommand).toBeDefined();
    expect(listCommand).toBeDefined();

    const setOptions = setCommand!.options.map((opt) => opt.long);
    const listOptions = listCommand!.options.map((opt) => opt.long);

    expect(setOptions).toContain('--stdin');
    expect(setOptions).toContain('--env-file');
    expect(setOptions).toContain('--describe');
    expect(setOptions).not.toContain('--encryption-fallback-enabled');
    expect(listOptions).not.toContain('--env-file');
    expect(listOptions).not.toContain('--encryption-fallback-enabled');
  });

  it('prompts for masked secret value and calls secret set endpoint', async () => {
    await makeRoot().parseAsync(['secret', 'set', 'API_KEY'], { from: 'user' });

    expect(mocks.prompt).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'password',
          name: 'secretValue',
          mask: '*',
        }),
      ])
    );

    expect(mocks.applySecretsToRemoteEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        itemEndpoint: 'https://example.invalid/item',
        secrets: [{ name: 'API_KEY', value: 'super-secret' }],
      })
    );

    expect(mocks.upsertSecretMetadata).toHaveBeenCalledWith(
      'API_KEY',
      process.cwd(),
      undefined
    );
  });

  it('passes custom description from --describe to metadata upsert', async () => {
    await makeRoot().parseAsync(
      ['secret', 'set', 'API_KEY', '--describe', 'Primary API key'],
      {
        from: 'user',
      }
    );

    expect(mocks.upsertSecretMetadata).toHaveBeenCalledWith(
      'API_KEY',
      process.cwd(),
      'Primary API key'
    );
  });

  it('falls back to placeholder behavior when --describe has no value', async () => {
    await makeRoot().parseAsync(['secret', 'set', 'API_KEY', '--describe'], {
      from: 'user',
    });

    expect(mocks.upsertSecretMetadata).toHaveBeenCalledWith(
      'API_KEY',
      process.cwd(),
      undefined
    );
  });

  it('calls list endpoint and does not require env file input', async () => {
    await makeRoot().parseAsync(['secret', 'list'], { from: 'user' });

    expect(mocks.getSecretsFromRemoteEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        itemEndpoint: 'https://example.invalid/item',
      })
    );
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it('reads a single secret from stdin when --stdin is used', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
    process.env.CI = 'true';

    Object.defineProperty(process.stdin, Symbol.asyncIterator, {
      configurable: true,
      value: async function* () {
        yield 'stdin-secret\n';
      },
    });

    await makeRoot().parseAsync(['secret', 'set', 'API_KEY', '--stdin'], {
      from: 'user',
    });

    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.applySecretsToRemoteEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        itemEndpoint: 'https://example.invalid/item',
        secrets: [{ name: 'API_KEY', value: 'stdin-secret' }],
      })
    );
  });

  it('applies multiple secrets from --env-file without prompting', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rayfin-secrets-'));
    const envFilePath = join(tempDir, 'secrets.env');

    try {
      writeFileSync(
        envFilePath,
        [
          '# comment',
          'API_KEY=abc123',
          'SECONDARY_KEY="quoted-value"',
          '',
        ].join('\n')
      );

      await makeRoot().parseAsync(
        ['secret', 'set', '--env-file', envFilePath],
        { from: 'user' }
      );

      expect(mocks.prompt).not.toHaveBeenCalled();
      expect(mocks.applySecretsToRemoteEndpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          itemEndpoint: 'https://example.invalid/item',
          secrets: [
            { name: 'API_KEY', value: 'abc123' },
            { name: 'SECONDARY_KEY', value: 'quoted-value' },
          ],
        })
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails when --stdin and --env-file are used together', async () => {
    await expect(
      makeRoot().parseAsync(
        ['secret', 'set', 'API_KEY', '--stdin', '--env-file', 'secrets.env'],
        { from: 'user' }
      )
    ).rejects.toThrow(CliHandledError);

    expect(mocks.applySecretsToRemoteEndpoint).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();

    const errorLines = getErrorLines();
    expect(errorLines).toEqual(
      expect.arrayContaining([
        '❌ --stdin and --env-file cannot be used together',
        '   Use either --stdin for one secret or --env-file for bulk set.',
      ])
    );
  });

  it('fails when --stdin is used without a secret name', async () => {
    await expect(
      makeRoot().parseAsync(['secret', 'set', '--stdin'], { from: 'user' })
    ).rejects.toThrow(CliHandledError);

    expect(mocks.applySecretsToRemoteEndpoint).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();

    const errorLines = getErrorLines();
    expect(errorLines).toEqual(
      expect.arrayContaining([
        '❌ Secret name is required when using --stdin',
        "   Use 'rayfin secret set <NAME> --stdin'.",
      ])
    );
  });

  it('fails when --env-file path does not exist', async () => {
    await expect(
      makeRoot().parseAsync(
        ['secret', 'set', '--env-file', 'this-file-does-not-exist.env'],
        {
          from: 'user',
        }
      )
    ).rejects.toThrow(CliHandledError);

    expect(mocks.applySecretsToRemoteEndpoint).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();

    const errorLines = getErrorLines();
    expect(
      errorLines.some((line) => line.startsWith('❌ Env file not found:'))
    ).toBe(true);
    expect(errorLines).toEqual(
      expect.arrayContaining(['   Check the path and re-run the command.'])
    );
  });

  it('fails when --env-file is provided with a name argument', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rayfin-secrets-'));
    const envFilePath = join(tempDir, 'secrets.env');

    try {
      writeFileSync(envFilePath, 'API_KEY=abc123\n');

      await expect(
        makeRoot().parseAsync(
          ['secret', 'set', 'API_KEY', '--env-file', envFilePath],
          {
            from: 'user',
          }
        )
      ).rejects.toThrow(CliHandledError);

      expect(mocks.applySecretsToRemoteEndpoint).not.toHaveBeenCalled();
      expect(mocks.prompt).not.toHaveBeenCalled();

      const errorLines = getErrorLines();
      expect(errorLines).toEqual(
        expect.arrayContaining([
          '❌ Do not pass <name> with --env-file',
          "   Use 'rayfin secret set --env-file <path>' for bulk updates.",
        ])
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails when stdin is empty in --stdin mode', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
    process.env.CI = 'true';

    Object.defineProperty(process.stdin, Symbol.asyncIterator, {
      configurable: true,
      value: async function* () {
        yield '\n';
      },
    });

    await expect(
      makeRoot().parseAsync(['secret', 'set', 'API_KEY', '--stdin'], {
        from: 'user',
      })
    ).rejects.toThrow(CliHandledError);

    expect(mocks.applySecretsToRemoteEndpoint).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();

    const errorLines = getErrorLines();
    expect(errorLines).toEqual(
      expect.arrayContaining([
        '❌ Failed to set secret: No secret value was provided on stdin.',
      ])
    );
  });

  it('registers a delete subcommand with a --yes option', () => {
    const deleteCommand = secretCommand.commands.find(
      (cmd) => cmd.name() === 'delete'
    );

    expect(deleteCommand).toBeDefined();
    expect(deleteCommand!.options.map((opt) => opt.long)).toContain('--yes');
  });

  it('deletes a secret without prompting when --yes is passed', async () => {
    await makeRoot().parseAsync(['secret', 'delete', 'API_KEY', '--yes'], {
      from: 'user',
    });

    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.deleteSecretFromRemoteEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        itemEndpoint: 'https://example.invalid/item',
        name: 'API_KEY',
      })
    );
  });

  it('removes the metadata entry and regenerates types after a delete', () => {
    // Without this the secret would linger in rayfin.yml and keep appearing in
    // the generated AppSecrets union after it no longer exists.
    return makeRoot()
      .parseAsync(['secret', 'delete', 'API_KEY', '--yes'], { from: 'user' })
      .then(() => {
        expect(mocks.removeSecretMetadata).toHaveBeenCalledWith(
          'API_KEY',
          expect.any(String)
        );
        expect(mocks.generateSecretsTypes).toHaveBeenCalled();
      });
  });

  it('regenerates types after a set', () => {
    mocks.prompt.mockResolvedValueOnce({ secretValue: 'super-secret' });

    return makeRoot()
      .parseAsync(['secret', 'set', 'NEW_KEY'], { from: 'user' })
      .then(() => {
        expect(mocks.upsertSecretMetadata).toHaveBeenCalledWith(
          'NEW_KEY',
          expect.any(String),
          undefined
        );
        expect(mocks.generateSecretsTypes).toHaveBeenCalled();
      });
  });

  it('prompts for confirmation and deletes when the user confirms', async () => {
    mocks.prompt.mockResolvedValueOnce({ confirm: true });

    await makeRoot().parseAsync(['secret', 'delete', 'API_KEY'], {
      from: 'user',
    });

    expect(mocks.prompt).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'confirm',
          name: 'confirm',
        }),
      ])
    );
    expect(mocks.deleteSecretFromRemoteEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        itemEndpoint: 'https://example.invalid/item',
        name: 'API_KEY',
      })
    );
  });

  it('cancels without deleting when the user declines the confirmation prompt', async () => {
    mocks.prompt.mockResolvedValueOnce({ confirm: false });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await makeRoot().parseAsync(['secret', 'delete', 'API_KEY'], {
      from: 'user',
    });

    expect(mocks.deleteSecretFromRemoteEndpoint).not.toHaveBeenCalled();
    expect(stderrSpy.mock.calls.flat().map(String)).toContain('Cancelled.\n');
  });

  it('shows a clear message and exits non-zero when the secret is not found (404)', async () => {
    mocks.deleteSecretFromRemoteEndpoint.mockRejectedValueOnce(
      new HttpError('Failed to delete secret "MISSING": 404', 404)
    );

    await expect(
      makeRoot().parseAsync(['secret', 'delete', 'MISSING', '--yes'], {
        from: 'user',
      })
    ).rejects.toThrow(CliHandledError);

    const errorLines = getErrorLines();
    expect(errorLines).toEqual(
      expect.arrayContaining([
        '❌ Secret "MISSING" was not found. It may already be deleted, or secret management may not be enabled for this item.',
        "   Run 'rayfin secret list' to see existing secrets.",
      ])
    );
  });

  it('fails with a generic error message for non-404 delete failures', async () => {
    mocks.deleteSecretFromRemoteEndpoint.mockRejectedValueOnce(
      new Error('boom')
    );

    await expect(
      makeRoot().parseAsync(['secret', 'delete', 'API_KEY', '--yes'], {
        from: 'user',
      })
    ).rejects.toThrow(CliHandledError);

    const errorLines = getErrorLines();
    expect(errorLines).toEqual(
      expect.arrayContaining(['❌ Failed to delete secret: boom'])
    );
  });

  /**
   * Shutdown contract.
   *
   * These commands reach the process teardown with native dependencies
   * loaded — `@azure/msal-node-extensions` pulls in DPAPI/keytar bindings,
   * which signal completion from the libuv threadpool through a
   * `uv_async_t`. Calling `process.exit()` from inside a handler tears the
   * loop down while those handles may still be closing, which on Windows
   * surfaces as `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
   * (`src\win\async.c`) *after* the command already reported success.
   *
   * It also skips `scripts/main`'s `finally`, so `shutdownTelemetry()`
   * never runs on those paths.
   *
   * The contract is therefore: handlers never exit the process. They throw,
   * and `scripts/main` owns the single ordered teardown.
   */
  describe('shutdown contract', () => {
    const exitPaths: Array<{ name: string; argv: string[] }> = [
      {
        name: 'a handled remote failure (404)',
        argv: ['secret', 'delete', 'MISSING', '--yes'],
      },
      {
        name: 'a conflicting-flag rejection',
        argv: ['secret', 'set', 'API_KEY', '--stdin', '--env-file', 'a.env'],
      },
      {
        name: 'a missing-endpoint rejection',
        argv: ['secret', 'list'],
      },
    ];

    for (const { name, argv } of exitPaths) {
      it(`does not call process.exit for ${name}`, async () => {
        mocks.deleteSecretFromRemoteEndpoint.mockRejectedValueOnce(
          new HttpError('Failed to delete secret "MISSING": 404', 404)
        );
        if (argv.includes('list')) {
          mocks.hasRemoteEndpoint.mockReturnValue(false);
        }
        const exitSpy = vi
          .spyOn(process, 'exit')
          .mockImplementation((() => undefined) as never);

        await expect(
          makeRoot().parseAsync(argv, { from: 'user' })
        ).rejects.toThrow(CliHandledError);

        expect(exitSpy).not.toHaveBeenCalled();
      });
    }

    it('reports success without exiting the process', async () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);

      await makeRoot().parseAsync(['secret', 'set', 'API_KEY'], {
        from: 'user',
      });

      expect(mocks.applySecretsToRemoteEndpoint).toHaveBeenCalledTimes(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('does not replay the remote mutation while unwinding a failure', async () => {
      mocks.applySecretsToRemoteEndpoint.mockResolvedValueOnce([]);

      await expect(
        makeRoot().parseAsync(['secret', 'set', 'API_KEY'], { from: 'user' })
      ).rejects.toThrow(CliHandledError);

      // The endpoint rejected the secret, so the command must surface that
      // once rather than retrying on the way out.
      expect(mocks.applySecretsToRemoteEndpoint).toHaveBeenCalledTimes(1);
      expect(mocks.upsertSecretMetadata).not.toHaveBeenCalled();
    });

    it('keeps the secret value out of the surfaced error', async () => {
      mocks.prompt.mockResolvedValueOnce({ secretValue: 'super-secret' });
      mocks.applySecretsToRemoteEndpoint.mockRejectedValueOnce(
        new Error('backend rejected the request')
      );

      const error = await makeRoot()
        .parseAsync(['secret', 'set', 'API_KEY'], { from: 'user' })
        .then(
          () => undefined,
          (caught: unknown) => caught
        );

      expect(error).toBeInstanceOf(CliHandledError);
      const surfaced = [
        (error as CliHandledError).message,
        (error as CliHandledError).stack ?? '',
        ...getErrorLines(),
      ].join('\n');
      expect(surfaced).not.toContain('super-secret');
    });
  });
});
