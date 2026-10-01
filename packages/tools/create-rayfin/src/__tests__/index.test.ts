/**
 * Orchestration tests for create-rayfin's entry point.
 *
 * Verifies that `main()` calls the telemetry lifecycle (init, hooks,
 * shutdown) in the right order and accounts for happy / failure / cancel
 * outcomes correctly. The telemetry module and the rayfin-cli init()
 * factory are mocked so tests can run without a real OTel exporter or a
 * real CLI.
 */
import { Command } from 'commander';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

// Telemetry module: mocked so we can spy on the lifecycle calls.
vi.mock('../telemetry/index.js', () => ({
  initTelemetry: vi.fn(async () => {}),
  installCommanderHooks: vi.fn(),
  markCurrentContextCancelled: vi.fn(),
  markCurrentContextFailure: vi.fn(),
  finalizeCurrentContext: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
  getCurrentContext: vi.fn(),
}));

// rayfin-cli init() factory: returns a stub Command we can program per test
// to throw or resolve from parseAsync.
let stubCommand: Command;
let stubParseAsync: Mock;
let capturedInitOptions: Record<string, unknown> | undefined;

vi.mock('@microsoft/rayfin-cli/_internal/commands/init.js', () => ({
  init: (options: Record<string, unknown>) => {
    capturedInitOptions = options;
    return stubCommand;
  },
}));

// Imports must follow the mocks so the dynamic import inside main() picks
// up the mocked modules.
import { main } from '../index.js';
import {
  finalizeCurrentContext,
  getCurrentContext,
  initTelemetry,
  installCommanderHooks,
  markCurrentContextCancelled,
  markCurrentContextFailure,
  shutdownTelemetry,
} from '../telemetry/index.js';

const mockedInitTelemetry = initTelemetry as Mock;
const mockedInstallHooks = installCommanderHooks as Mock;
const mockedMarkCancelled = markCurrentContextCancelled as Mock;
const mockedMarkFailure = markCurrentContextFailure as Mock;
const mockedFinalize = finalizeCurrentContext as Mock;
const mockedShutdown = shutdownTelemetry as Mock;
const mockedGetCurrentContext = getCurrentContext as Mock;

beforeEach(() => {
  capturedInitOptions = undefined;
  stubCommand = new Command();
  stubParseAsync = vi.fn(async () => stubCommand);
  // Replace parseAsync with our spy so each test can program its behavior.
  stubCommand.parseAsync = stubParseAsync as unknown as Command['parseAsync'];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('create-rayfin main() orchestration', () => {
  it('happy path: init → install hooks → parseAsync → shutdown, returns 0', async () => {
    const exitCode = await main(['node', 'create-rayfin', '--help']);

    expect(exitCode).toBe(0);
    expect(mockedInitTelemetry).toHaveBeenCalledTimes(1);
    expect(mockedInstallHooks).toHaveBeenCalledTimes(1);
    expect(stubParseAsync).toHaveBeenCalledTimes(1);
    expect(mockedShutdown).toHaveBeenCalledTimes(1);

    // Verify ordering via call invocation order.
    const initOrder = mockedInitTelemetry.mock.invocationCallOrder[0];
    const hooksOrder = mockedInstallHooks.mock.invocationCallOrder[0];
    const parseOrder = stubParseAsync.mock.invocationCallOrder[0];
    const shutdownOrder = mockedShutdown.mock.invocationCallOrder[0];
    expect(initOrder).toBeLessThan(hooksOrder);
    expect(hooksOrder).toBeLessThan(parseOrder);
    expect(parseOrder).toBeLessThan(shutdownOrder);

    // No failure path triggered.
    expect(mockedMarkFailure).not.toHaveBeenCalled();
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it('error path: parseAsync throws → markCurrentContextFailure called → shutdown still flushes → returns 1', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    stubParseAsync.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const exitCode = await main(['node', 'create-rayfin', 'init']);

    expect(exitCode).toBe(1);
    expect(mockedMarkFailure).toHaveBeenCalledTimes(1);
    expect(mockedMarkFailure.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((mockedMarkFailure.mock.calls[0][0] as Error).message).toBe('boom');
    expect(mockedShutdown).toHaveBeenCalledTimes(1); // finally still runs
    expect(mockedFinalize).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('boom');

    consoleError.mockRestore();
  });

  it('cancel path: ExitPromptError → finalizeCurrentContext("userFault") → shutdown called → returns 0', async () => {
    const consoleLog = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const cancelErr = new Error('user cancelled');
    cancelErr.name = 'ExitPromptError';
    stubParseAsync.mockImplementationOnce(async () => {
      throw cancelErr;
    });

    const exitCode = await main(['node', 'create-rayfin', 'init']);

    expect(exitCode).toBe(0);
    expect(mockedFinalize).toHaveBeenCalledTimes(1);
    expect(mockedFinalize).toHaveBeenCalledWith(
      'userFault',
      'cancelled by user'
    );
    expect(mockedShutdown).toHaveBeenCalledTimes(1);
    expect(mockedMarkFailure).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith('\nOperation cancelled.');

    consoleLog.mockRestore();
  });

  it('cancel path: ScaffoldCancelledError → markCurrentContextCancelled() → returns 2 (not 0, not 1)', async () => {
    // Regression for the cancellation discriminator gap. When the
    // dispatcher throws ScaffoldCancelledError (e.g. user declined
    // overwrite), telemetry must record the dedicated `Canceled`
    // category — distinct from both Success and Failure so dashboards
    // can aggregate user-decline separately from operation crashes.
    // Exit code 2 (distinct from 1=failure) lets machine consumers
    // see "user said no" apart from "operation crashed".
    //
    // Privacy contract: no message argument is forwarded to telemetry.
    // markCurrentContextCancelled is the symmetric API for both wrappers
    // (this and `@microsoft/rayfin-cli`'s scripts/main); it takes no
    // arguments so cancellation messages cannot leak user input
    // (URLs/paths) into the telemetry resultSummary field.
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { ScaffoldCancelledError } =
      await import('@microsoft/rayfin-cli/_internal/errors.js');
    const cancelErr = new ScaffoldCancelledError();
    stubParseAsync.mockImplementationOnce(async () => {
      throw cancelErr;
    });

    const exitCode = await main(['node', 'create-rayfin', 'init']);

    expect(exitCode).toBe(2);
    expect(mockedMarkCancelled).toHaveBeenCalledTimes(1);
    // No-arg call enforces the privacy contract structurally.
    expect(mockedMarkCancelled).toHaveBeenCalledWith();
    expect(mockedFinalize).not.toHaveBeenCalled();
    expect(mockedShutdown).toHaveBeenCalledTimes(1);
    expect(mockedMarkFailure).not.toHaveBeenCalled();
    // Handler already emitted the friendly message — wrapper must NOT
    // re-print to stderr.
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('failure path: CliHandledError → markFailure with original error → exit 1, no re-print to stderr', async () => {
    // Regression for the create-rayfin double-print bug. Pre-fix, the
    // wrapper's failure branch always called console.error(err.message),
    // even for CliHandledError. CliHandledError signals "the handler
    // already showed a friendly message" — re-printing produces a
    // duplicate user-facing line. Mirrors the same single-emit
    // contract honored by `@microsoft/rayfin-cli`'s scripts/main.
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { CliHandledError } =
      await import('@microsoft/rayfin-cli/_internal/errors.js');
    const originalError = new Error('Template path does not exist');
    const wrapped = new CliHandledError(originalError);
    stubParseAsync.mockImplementationOnce(async () => {
      throw wrapped;
    });

    const exitCode = await main(['node', 'create-rayfin', 'init']);

    expect(exitCode).toBe(1);
    expect(mockedShutdown).toHaveBeenCalledTimes(1);
    // Telemetry receives the ORIGINAL error (preserves errorType/errorName
    // for dashboards), not the CliHandledError wrapper.
    expect(mockedMarkFailure).toHaveBeenCalledTimes(1);
    expect(mockedMarkFailure).toHaveBeenCalledWith(originalError);
    // Wrapper must NOT re-print — handler already emitted modeError.
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('shutdown is in finally: even if telemetry init throws, scaffolding still runs and shutdown is attempted', async () => {
    mockedInitTelemetry.mockImplementationOnce(async () => {
      throw new Error('telemetry boot failed');
    });

    const exitCode = await main(['node', 'create-rayfin', '--help']);

    // Init failure should not block scaffolding; parseAsync must still run.
    expect(stubParseAsync).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
    // Shutdown is in finally, so it always runs.
    expect(mockedShutdown).toHaveBeenCalledTimes(1);
  });

  it('shutdown failures do not override the command exit code', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockedShutdown.mockImplementationOnce(async () => {
      throw new Error('flush timeout');
    });

    // Happy path command, but shutdown throws after.
    const exitCode = await main(['node', 'create-rayfin', '--help']);
    expect(exitCode).toBe(0);
    consoleError.mockRestore();
  });

  it('installCommanderHooks receives a program already named "create-rayfin"', async () => {
    await main(['node', 'create-rayfin', '--help']);
    expect(mockedInstallHooks).toHaveBeenCalledTimes(1);
    const [programArg] = mockedInstallHooks.mock.calls[0] as [Command, string];
    expect(programArg.name()).toBe('create-rayfin');
  });

  it('installCommanderHooks is passed the package version as the second argument', async () => {
    await main(['node', 'create-rayfin', '--help']);
    const [, versionArg] = mockedInstallHooks.mock.calls[0] as [
      Command,
      string,
    ];
    expect(typeof versionArg).toBe('string');
    expect(versionArg).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('supplies the active create correlation id to init', async () => {
    const correlationId = '9f970daa-6101-4df2-98f9-e0d86e975c61';
    mockedGetCurrentContext.mockReturnValue({ correlationId });

    await main(['node', 'create-rayfin', '--help']);

    expect(capturedInitOptions?.['createProjectSemantics']).toBe(true);
    const getProjectOriginId = capturedInitOptions?.['getProjectOriginId'] as
      | (() => string | undefined)
      | undefined;
    expect(getProjectOriginId?.()).toBe(correlationId);
  });
});
