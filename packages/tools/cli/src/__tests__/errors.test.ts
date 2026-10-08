import { FabricError } from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { failUp } from '../commands/up/render.js';
import {
  classifyCliError,
  CliCancelledError,
  CliHandledError,
  FABRIC_CAPACITY_EXHAUSTED_ERROR,
  getCliErrorPresentation,
  getFabricCapacityExhaustedError,
  ScaffoldCancelledError,
} from '../errors.js';

afterEach(() => vi.restoreAllMocks());

describe('CLI error policy', () => {
  it('maps the exhausted-capacity Fabric error to its CLI presentation', () => {
    const presentation = getFabricCapacityExhaustedError(
      new FabricError('Create item failed: 429', 429, 'CapacityLimitExceeded')
    );

    expect(presentation).toEqual({
      code: 'fabric-capacity-exhausted',
      message:
        'The Fabric capacity assigned to this workspace is exhausted and cannot create another Rayfin item.',
      hint: 'You must pass a valid workspace ID with `--workspace-id <id>` or a valid capacity ID with `--capacity-id <id>` to complete deployment.',
    });
    expect(presentation).toBe(FABRIC_CAPACITY_EXHAUSTED_ERROR);
  });

  it('does not treat unrelated failures as exhausted capacity', () => {
    expect(
      getFabricCapacityExhaustedError(
        new FabricError('unknown', 400, 'OtherError')
      )
    ).toBeUndefined();
    expect(
      getFabricCapacityExhaustedError(new Error('unknown'))
    ).toBeUndefined();
  });

  it('maps a stable workflow code to the exhausted-capacity presentation', () => {
    expect(
      getCliErrorPresentation('fabric-capacity-exhausted', 'service detail')
    ).toBe(FABRIC_CAPACITY_EXHAUSTED_ERROR);
    expect(getCliErrorPresentation('up-failed', 'service detail')).toEqual({
      message: 'service detail',
    });
  });

  it.each([
    [new CliCancelledError(), 'cancelled', 2],
    [new ScaffoldCancelledError(), 'cancelled', 2],
    [
      Object.assign(new Error('prompt closed'), { name: 'ExitPromptError' }),
      'cancelled',
      0,
    ],
    [new Error('failure'), 'failed', 1],
    [new CliHandledError(new Error('rendered')), 'failed', 1],
    ['unexpected rejection', 'failed', 1],
  ] as const)(
    'classifies %s consistently for diagnostics and the entrypoint',
    (error, status, exitCode) => {
      expect(classifyCliError(error)).toEqual({ status, exitCode });
    }
  );

  it.each(['json', 'plain'] as const)(
    'preserves the original cause when rendering %s',
    (mode) => {
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const errorOutput = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const cause = Object.assign(new TypeError('original failure'), {
        code: 'E_ORIGINAL',
      });
      let caught: unknown;
      try {
        failUp(
          mode,
          'Deployment failed.\n   Check configuration.',
          { diagnosticLog: '/logs/run.log' },
          cause
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CliHandledError);
      expect((caught as CliHandledError).originalError).toBe(cause);
      if (mode === 'json') {
        expect(write).toHaveBeenCalledOnce();
        expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({
          status: 'error',
          error: 'Deployment failed.\n   Check configuration.',
          diagnosticLog: '/logs/run.log',
        });
      } else {
        expect(errorOutput.mock.calls.map(([text]) => text)).toEqual([
          '\u274c Deployment failed.\n   Check configuration.',
          '   Diagnostic log: /logs/run.log',
        ]);
      }
    }
  );
});
