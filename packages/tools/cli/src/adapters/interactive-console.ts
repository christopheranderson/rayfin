/**
 * Layer 1 interactive console: a single owner of the terminal that coordinates
 * the {@link Progress} spinner with {@link UserInteraction} prompts so the two
 * never write to the TTY at once.
 *
 * An ora spinner repaints its line on a timer. When an inquirer prompt renders
 * while the spinner is still spinning, the repaint overwrites the question —
 * the user sees a half-drawn line and no visible prompt, yet stdin is blocked
 * on the hidden confirm (pressing Enter "fixes" it by answering the unseen
 * prompt). This console suspends the spinner for the duration of every prompt
 * and resumes it afterward, so mid-workflow prompts are always legible.
 *
 * Per RFC Rule #2 the ora / inquirer concerns stay confined to this Layer 1
 * adapter; workflows and services only ever see the `Progress` /
 * `UserInteraction` interfaces.
 */
import type {
  Logger,
  Progress,
  SelectChoice,
  SelectOptions,
  UserInteraction,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import ora, { type Ora } from 'ora';

import { createOraProgress } from './progress.js';
import { cliUserInteraction } from './user-interaction.js';

/** A terminal-owning console that serializes spinner updates with prompts. */
export interface InteractiveConsole {
  /** Push-style progress that drives the shared spinner's text. */
  readonly progress: Progress;
  /** Durable output that remains visible after subsequent spinner updates. */
  readonly logger: Logger;
  /** Prompts that suspend the spinner while the user answers. */
  readonly ui: UserInteraction;
  /**
   * Write text (a warning or captured build output) to stderr without the
   * spinner garbling it: the spinner is stopped for the write and restarted
   * after. Use for failure-path diagnostics that must stay legible.
   */
  writeDiagnostic(text: string): void;
  /** Stop and clear the spinner. */
  stop(): void;
}

/**
 * Wrap a {@link UserInteraction} so each call stops the spinner before
 * prompting and restarts it afterward — but only when it was actually
 * spinning, so a prompt issued while the spinner is already paused leaves it
 * paused. The spinner is restored in a `finally` so a thrown or rejected
 * prompt never strands the terminal with no visible spinner.
 */
export function suspendSpinnerDuringPrompts(
  spinner: Ora,
  inner: UserInteraction
): UserInteraction {
  async function whileSuspended<T>(run: () => Promise<T>): Promise<T> {
    // Assumes prompts run sequentially: `wasSpinning` is captured per call, so
    // overlapping prompts would mis-track the spinner (the first's `finally`
    // could restart it while the second is still awaiting input). Inquirer
    // serializes on stdin, so this holds today; switch to a suspend
    // depth-counter if concurrent prompts are ever introduced.
    const wasSpinning = spinner.isSpinning;
    if (wasSpinning) {
      spinner.stop();
    }
    try {
      return await run();
    } finally {
      if (wasSpinning) {
        spinner.start();
      }
    }
  }

  return {
    prompt(message: string, options?: { default?: string }) {
      return whileSuspended(() => inner.prompt(message, options));
    },
    confirm(message: string, options?: { default?: boolean }) {
      return whileSuspended(() => inner.confirm(message, options));
    },
    select<T>(
      message: string,
      choices: SelectChoice<T>[],
      options?: SelectOptions
    ) {
      return whileSuspended(() => inner.select<T>(message, choices, options));
    },
  };
}

/**
 * Create an {@link InteractiveConsole} backed by a single ora spinner and the
 * inquirer-based {@link cliUserInteraction}. The spinner starts immediately and
 * runs until {@link InteractiveConsole.stop}; the first `progress.report`
 * overwrites the `initialText`.
 */
export function createInteractiveConsole(
  initialText = 'Working…'
): InteractiveConsole {
  const spinner: Ora = ora({ text: initialText, color: 'blue' }).start();
  const writeWhileSuspended = (
    write: (message: string) => void,
    message: string
  ): void => {
    const wasSpinning = spinner.isSpinning;
    if (wasSpinning) {
      spinner.stop();
    }
    try {
      write(message);
    } finally {
      if (wasSpinning) {
        spinner.start();
      }
    }
  };
  return {
    progress: createOraProgress(spinner),
    logger: {
      log: (message) => writeWhileSuspended(console.log, message),
      warn: (message) => writeWhileSuspended(console.warn, message),
      error: (message) => writeWhileSuspended(console.error, message),
    },
    ui: suspendSpinnerDuringPrompts(spinner, cliUserInteraction),
    writeDiagnostic: (text: string) =>
      writeWhileSuspended((message) => {
        process.stderr.write(message);
      }, text),
    stop: () => spinner.stop(),
  };
}
