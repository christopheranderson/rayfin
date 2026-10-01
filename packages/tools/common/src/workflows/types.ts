/**
 * Core workflow type contracts for the Rayfin tools target architecture.
 *
 * A workflow is the Layer 2 orchestration unit: `(req, deps) => Result`.
 * It sequences named steps, composes shared services through its declared
 * `Deps`, and returns a typed {@link Result}. It never throws for expected
 * failure and never calls `process.exit` — Layer 1 maps the `Result` to an
 * exit code or UI affordance.
 *
 * See docs/rfc/rayfin-tools-architecture.md ("Workflow signature & Deps").
 */

/**
 * Structured outcome of a workflow.
 *
 * - `ok` — success, carrying typed `data` and optional non-fatal `warnings`.
 * - `cancelled` — the caller (or a cancellation token) aborted the run; no
 *   error, no partial-success semantics implied.
 * - `failed` — an expected failure with a stable, machine-readable `code`,
 *   a human `message`, the original `cause` for diagnostics, and optional
 *   typed side-effect notices that must survive a later failure.
 */
export type Result<T, Notice = never> =
  | { status: 'ok'; data: T; warnings?: string[] }
  | { status: 'cancelled'; warnings?: string[]; notices?: Notice[] }
  | {
      status: 'failed';
      error: { code: string; message: string; cause?: unknown };
      warnings?: string[];
      notices?: Notice[];
    };

/**
 * A Layer 2 workflow: maps a typed request to a typed {@link Result} using
 * only the capabilities declared in `Deps`.
 */
export type Workflow<Req, Res, Deps, Notice = never> = (
  req: Req,
  deps: Deps
) => Promise<Result<Res, Notice>>;

/**
 * A workflow-internal step: a discrete, named unit that takes typed input
 * and returns typed output, composing services from its `Deps` slice. Steps
 * may narrow `Deps` to only what they use.
 *
 * Failure convention: an expected **user cancellation** (e.g. declining a
 * reuse prompt) is returned as a typed value in the step's output union, so
 * the workflow entrypoint can map it to a `cancelled` {@link Result} without
 * inspecting error types. All other expected failures and unexpected errors
 * are thrown and translated to a `failed` {@link Result} by the entrypoint.
 * A step whose output has no cancellation variant simply throws for every
 * expected failure and returns its value directly.
 */
export type Step<I, O, Deps> = (input: I, deps: Deps) => Promise<O>;

/** Construct an `ok` result. */
export function ok<T>(data: T, warnings?: string[]): Result<T> {
  return warnings && warnings.length > 0
    ? { status: 'ok', data, warnings }
    : { status: 'ok', data };
}

/** Construct a `cancelled` result. */
export function cancelled<Notice = never>(
  notices?: Notice[],
  warnings?: string[]
): Result<never, Notice> {
  return {
    status: 'cancelled',
    ...(notices && notices.length > 0 ? { notices } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

/** Construct a `failed` result. */
export function failed<Notice = never>(
  code: string,
  message: string,
  cause?: unknown,
  notices?: Notice[],
  warnings?: string[]
): Result<never, Notice> {
  const result: Result<never, Notice> = {
    status: 'failed',
    error: { code, message, cause },
  };
  if (notices && notices.length > 0) {
    result.notices = notices;
  }
  if (warnings && warnings.length > 0) {
    result.warnings = warnings;
  }
  return result;
}
