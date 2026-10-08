import { FabricError } from '@microsoft/rayfin-tools-common/_internal/external/fabric';

/** CLI presentation for a Fabric capacity that cannot accept another item. */
export const FABRIC_CAPACITY_EXHAUSTED_ERROR = {
  code: 'fabric-capacity-exhausted',
  message:
    'The Fabric capacity assigned to this workspace is exhausted and cannot create another Rayfin item.',
  hint: 'You must pass a valid workspace ID with `--workspace-id <id>` or a valid capacity ID with `--capacity-id <id>` to complete deployment.',
} as const;

/** Return the capacity-exhausted presentation for its stable Fabric error code. */
export function getFabricCapacityExhaustedError(
  error: unknown
): typeof FABRIC_CAPACITY_EXHAUSTED_ERROR | undefined {
  return error instanceof FabricError &&
    error.errorCode?.toLowerCase() === 'capacitylimitexceeded'
    ? FABRIC_CAPACITY_EXHAUSTED_ERROR
    : undefined;
}

/** Resolve a workflow failure code to its CLI message and recovery hint. */
export function getCliErrorPresentation(
  code: string,
  fallbackMessage: string
): { message: string; hint?: string } {
  return code === FABRIC_CAPACITY_EXHAUSTED_ERROR.code
    ? FABRIC_CAPACITY_EXHAUSTED_ERROR
    : { message: fallbackMessage };
}

/**
 * Thrown by command handlers that have already displayed their error
 * message to the user.
 *
 * The CLI entry point records this as a telemetry failure but does
 * **not** re-display the message, avoiding duplicate console output.
 */
export class CliHandledError extends Error {
  override readonly name = 'CliHandledError';

  constructor(readonly originalError: unknown) {
    super(
      originalError instanceof Error
        ? originalError.message
        : String(originalError)
    );
    if (originalError instanceof Error) {
      this.stack = originalError.stack;
    }
  }
}

/**
 * Thrown by the scaffold dispatcher when the user cancels (e.g. declined
 * an overwrite prompt). Distinct from {@link CliHandledError} because
 * cancellation is not a failure — telemetry should record it under the
 * dedicated `Canceled` category (not `Failure` or `UserFault`), and
 * machine consumers should see a non-zero-but-distinct exit code (2) so
 * they can tell "user said no" apart from "operation crashed" (1).
 *
 * Why thrown rather than returned: Commander's `parseAsync` does not
 * propagate action-callback return values, so a returned discriminator
 * is invisible to wrappers like `create-rayfin` that need to attribute
 * telemetry. Throwing is the only signal both `rayfin` (`scripts/main`)
 * and `create-rayfin` (`src/index.ts`) can observe identically.
 *
 * **Privacy contract** (structural): cancellation may originate from
 * contexts where a message would naturally include user-derived content
 * (template URLs with `x-access-token:...`, local file paths with PII,
 * project names). To make leakage impossible, this constructor takes
 * NO arguments — every instance carries the same fixed safe message.
 * The wrappers (`markCurrentContextCancelled()` in rayfin,
 * `finalizeCurrentContext('cancelled', ...)` in create-rayfin)
 * additionally drop any message when attributing cancellation telemetry,
 * but that secondary defense isn't relied on for correctness — the
 * type itself enforces the guarantee.
 */
export class CliCancelledError extends Error {
  override readonly name: string = 'CliCancelledError';

  constructor() {
    super('Operation cancelled by user');
  }
}

export class ScaffoldCancelledError extends CliCancelledError {
  override readonly name = 'ScaffoldCancelledError';
}

/** @internal */
export function classifyCliError(
  error: unknown
):
  | { status: 'cancelled'; exitCode: 0 | 2 }
  | { status: 'failed'; exitCode: 1 } {
  if (error instanceof CliCancelledError) {
    return { status: 'cancelled', exitCode: 2 };
  }
  if (error instanceof Error && error.name === 'ExitPromptError') {
    return { status: 'cancelled', exitCode: 0 };
  }
  return { status: 'failed', exitCode: 1 };
}
