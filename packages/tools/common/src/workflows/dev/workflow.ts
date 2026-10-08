/**
 * `runDevWorkflow` — the `dev` Layer 2 orchestration.
 *
 * Reads as a table of contents: resolve the backend target → make it ready →
 * sync services/connectors → apply my declared state → reserve local runtimes →
 * prepare local wiring → prepare those runtimes → start my code locally. The
 * step list is **identical across providers**; only the injected `deps.backend`
 * strategy differs, and the workflow never branches on the provider id.
 *
 * Runtime provisioning brackets the wiring step because the two depend on each
 * other: the frontend env needs the ports the local runtimes will serve on,
 * and those runtimes need the backend values the wiring produces.
 *
 * The session is long-running: `start-local-runtimes` returns when the local
 * runtimes exit or the {@link CancellationToken} terminates them (Ctrl-C).
 * Whatever the outcome — success, failure, or cancel — the `finally` disposes
 * every prepared runtime (closing watchers) and runs the provider's `teardown`
 * so a backend that owns resources (Docker containers) is always torn down.
 * Returns a typed {@link Result} and never throws for expected failure or calls
 * `process.exit`; Layer 1 maps the result to output and an exit code.
 *
 * See docs/rfc/rfc-cli-dev-inner-loop.md and
 * docs/rfc/rayfin-tools-architecture.md ("Workflow signature & Deps").
 */
import { type Workflow, cancelled, failed, ok } from '../types.js';

import type { DevTarget } from './providers/index.js';
import type { LocalRuntimeSpec } from './runtimes.js';
import { applyDeclaredState } from './steps/apply-declared-state.js';
import { ensureBackendReady } from './steps/ensure-backend-ready.js';
import { prepareLocalRuntimes } from './steps/prepare-local-runtimes.js';
import { prepareLocalWiring } from './steps/prepare-local-wiring.js';
import {
  reserveLocalRuntimes,
  reservedRuntimeUrls,
} from './steps/reserve-local-runtimes.js';
import { resolveTarget } from './steps/resolve-target.js';
import { startLocalRuntimes } from './steps/start-local-runtimes.js';
import { syncConnectors } from './steps/sync-connectors.js';
import { validateRequest } from './steps/validate-request.js';
import type { DevDeps, DevRequest, DevResult } from './types.js';

export const runDevWorkflow: Workflow<DevRequest, DevResult, DevDeps> = async (
  req,
  deps
) => {
  const { backend, runner, diagnostics, signal } = deps;
  // Runtime steps reuse this reporter and can include host-supplied labels in
  // messages. Persist the fixed phase, not those potentially sensitive labels.
  const progress: DevDeps['progress'] = {
    report(update) {
      diagnostics.debug({
        area: 'dev',
        message: 'Workflow phase',
        data: { phase: update.phase },
      });
      deps.progress.report(update);
    },
  };
  const isCancelled = (): boolean => signal?.isCancellationRequested === true;

  diagnostics.debug({ area: 'dev', message: 'Validating request' });
  const validation = await validateRequest(req, {});
  if (validation.status === 'invalid') {
    return failed('invalid-request', validation.errors.join('\n'));
  }

  const warnings: string[] = [];
  let target: DevTarget | undefined;
  let preparedRuntimes: LocalRuntimeSpec[] = [];

  try {
    if (isCancelled()) return cancelled();
    progress.report({ phase: 'target', message: 'Resolving backend target' });
    target = await resolveTarget(
      { projectRoot: req.projectRoot, config: req.config },
      { backend }
    );

    if (isCancelled()) return cancelled();
    progress.report({ phase: 'backend', message: 'Ensuring backend is ready' });
    const ready = await ensureBackendReady({ target }, { backend });
    if (isCancelled()) {
      return cancelled();
    }
    if (ready.status === 'cancelled') {
      return cancelled();
    }
    if (ready.status === 'unavailable') {
      return failed(ready.code, ready.message);
    }
    target = ready.target;
    warnings.push(...(ready.warnings ?? []));

    if (isCancelled()) return cancelled();
    progress.report({
      phase: 'settings',
      message: 'Syncing services and connectors',
    });
    const connectors = await syncConnectors(
      { target, connectors: req.config.connectors },
      { backend }
    );
    if (connectors.status === 'invalid-connectors') {
      return failed(
        'invalid-connectors',
        `connectors block in rayfin.yml has validation errors:\n${connectors.errors
          .map((e) => `  • ${e.sourceName}: ${e.message}`)
          .join('\n')}`
      );
    }

    if (isCancelled()) return cancelled();
    progress.report({
      phase: 'declared-state',
      message: 'Applying declared backend state',
    });
    await applyDeclaredState(
      {
        target,
        projectRoot: req.projectRoot,
        services: req.config.services,
        skipDataApply: req.skipDataApply,
      },
      { backend }
    );

    if (isCancelled()) return cancelled();
    progress.report({
      phase: 'runtimes',
      message: 'Reserving local runtimes',
    });
    const reservation = await reserveLocalRuntimes(
      {},
      { runtimes: deps.runtimes, signal }
    );
    if (reservation.status === 'unavailable') {
      return failed(reservation.code, reservation.message);
    }
    warnings.push(...(reservation.warnings ?? []));
    const runtimeUrls = reservedRuntimeUrls(reservation);

    if (isCancelled()) return cancelled();
    progress.report({ phase: 'wiring', message: 'Preparing local wiring' });
    const wiring = await prepareLocalWiring(
      { target, runtimeUrls },
      { backend }
    );
    warnings.push(...(wiring.warnings ?? []));

    if (isCancelled()) return cancelled();
    progress.report({
      phase: 'runtimes',
      message: 'Preparing local runtimes',
    });
    const prepared = await prepareLocalRuntimes(
      { env: wiring.env, reservations: reservation.reservations },
      { runtimes: deps.runtimes, signal }
    );
    if (prepared.status === 'cancelled') return cancelled();
    if (prepared.status === 'unavailable') {
      return failed(prepared.code, prepared.message);
    }
    warnings.push(...(prepared.warnings ?? []));
    preparedRuntimes = prepared.runtimes;

    if (isCancelled()) return cancelled();
    progress.report({
      phase: 'runtimes',
      message: 'Starting local runtimes',
    });
    const runtimes = await startLocalRuntimes(
      { runtimes: preparedRuntimes, env: wiring.env },
      { runner, progress, signal }
    );
    warnings.push(...runtimes.warnings);
    if (runtimes.cancelled || isCancelled()) {
      if (runtimes.failure) {
        warnings.push(
          `Runtime failure during shutdown: ${runtimes.failure.message}`
        );
      }
      return cancelled(undefined, warnings);
    }
    if (runtimes.failure) {
      return failed(runtimes.failure.code, runtimes.failure.message);
    }

    return ok(
      {
        provider: req.provider,
        target: { displayName: target.displayName, apiUrl: target.apiUrl },
        startedRuntimes: runtimes.started,
        runtimeUrls,
        warnings,
      },
      warnings
    );
  } catch (error) {
    diagnostics.debug({
      area: 'dev',
      message: 'Workflow failed',
      data: { code: 'dev-failed' },
    });
    return failed(
      'dev-failed',
      error instanceof Error ? error.message : String(error),
      error
    );
  } finally {
    diagnostics.debug({ area: 'dev', message: 'Releasing session resources' });
    // Release whatever preparing the runtimes acquired (typegen watchers,
    // pending readiness probes) before the backend goes away. A disposal
    // failure must not mask the workflow's real outcome.
    for (const runtime of preparedRuntimes) {
      try {
        await runtime.dispose?.();
      } catch {
        diagnostics.debug({ area: 'dev', message: 'Runtime disposal failed' });
        // Swallow — the session outcome above is authoritative.
      }
    }

    // Best-effort teardown of whatever the provider owns (Docker containers;
    // a no-op for Fabric). Runs on success, failure, and cancel alike so a
    // long-running session never leaks backend resources. A teardown failure
    // must not mask the workflow's real outcome.
    if (target) {
      try {
        await backend.teardown(target, { purge: req.purge });
      } catch {
        diagnostics.debug({ area: 'dev', message: 'Backend teardown failed' });
        // Swallow — the session outcome above is authoritative.
      }
    }
    diagnostics.debug({ area: 'dev', message: 'Session cleanup completed' });
  }
};
