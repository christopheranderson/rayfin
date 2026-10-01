import type {
  SelectChoice,
  UserInteraction,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { Ora } from 'ora';
import { describe, expect, it, vi } from 'vitest';

import { suspendSpinnerDuringPrompts } from '../interactive-console.js';

/**
 * A minimal ora double tracking only the spin state and start/stop calls the
 * coordinator depends on. Cast to {@link Ora} at the seam (mirroring
 * `progress.test.ts`) so the test never starts a real spinner.
 */
function fakeSpinner(spinning: boolean): {
  isSpinning: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const spinner = {
    isSpinning: spinning,
    start: vi.fn(() => {
      spinner.isSpinning = true;
      return spinner;
    }),
    stop: vi.fn(() => {
      spinner.isSpinning = false;
      return spinner;
    }),
  };
  return spinner;
}

/**
 * A {@link UserInteraction} double that records whether the spinner was still
 * spinning at the moment it was asked to prompt — the exact race the
 * coordinator exists to prevent.
 */
function recordingUi(
  spinner: { isSpinning: boolean },
  observed: { spinningWhilePrompting: boolean | null }
): UserInteraction {
  return {
    async prompt() {
      observed.spinningWhilePrompting = spinner.isSpinning;
      return 'typed';
    },
    async confirm() {
      observed.spinningWhilePrompting = spinner.isSpinning;
      return true;
    },
    async select<T>(_message: string, choices: SelectChoice<T>[]) {
      observed.spinningWhilePrompting = spinner.isSpinning;
      return choices[0]?.value;
    },
  };
}

describe('suspendSpinnerDuringPrompts', () => {
  it('stops the spinner before prompting and restarts it after', async () => {
    const spinner = fakeSpinner(true);
    const observed = { spinningWhilePrompting: null as boolean | null };
    const ui = suspendSpinnerDuringPrompts(
      spinner as unknown as Ora,
      recordingUi(spinner, observed)
    );

    const answer = await ui.confirm('Reuse the existing item?');

    // The prompt ran with the spinner stopped, then it was restarted.
    expect(observed.spinningWhilePrompting).toBe(false);
    expect(spinner.stop).toHaveBeenCalledTimes(1);
    expect(spinner.start).toHaveBeenCalledTimes(1);
    expect(spinner.isSpinning).toBe(true);
    expect(answer).toBe(true);
  });

  it('forwards the entered value for a free-text prompt', async () => {
    const spinner = fakeSpinner(true);
    const observed = { spinningWhilePrompting: null as boolean | null };
    const ui = suspendSpinnerDuringPrompts(
      spinner as unknown as Ora,
      recordingUi(spinner, observed)
    );

    expect(await ui.prompt('Workspace name?')).toBe('typed');
    expect(observed.spinningWhilePrompting).toBe(false);
  });

  it('suspends the spinner around a select prompt and forwards the choice', async () => {
    const spinner = fakeSpinner(true);
    const observed = { spinningWhilePrompting: null as boolean | null };
    const ui = suspendSpinnerDuringPrompts(
      spinner as unknown as Ora,
      recordingUi(spinner, observed)
    );

    const choice = await ui.select('Pick one', [{ label: 'A', value: 'a' }]);

    expect(observed.spinningWhilePrompting).toBe(false);
    expect(choice).toBe('a');
    expect(spinner.start).toHaveBeenCalledTimes(1);
  });

  it('leaves an already-paused spinner paused (no spurious restart)', async () => {
    const spinner = fakeSpinner(false);
    const observed = { spinningWhilePrompting: null as boolean | null };
    const ui = suspendSpinnerDuringPrompts(
      spinner as unknown as Ora,
      recordingUi(spinner, observed)
    );

    await ui.confirm('Proceed?');

    expect(spinner.stop).not.toHaveBeenCalled();
    expect(spinner.start).not.toHaveBeenCalled();
    expect(spinner.isSpinning).toBe(false);
  });

  it('restarts the spinner even when the prompt rejects', async () => {
    const spinner = fakeSpinner(true);
    const failingUi: UserInteraction = {
      prompt: async () => undefined,
      confirm: async () => {
        throw new Error('stdin closed');
      },
      select: async () => undefined,
    };
    const ui = suspendSpinnerDuringPrompts(
      spinner as unknown as Ora,
      failingUi
    );

    await expect(ui.confirm('Proceed?')).rejects.toThrow('stdin closed');
    expect(spinner.stop).toHaveBeenCalledTimes(1);
    expect(spinner.start).toHaveBeenCalledTimes(1);
    expect(spinner.isSpinning).toBe(true);
  });
});
