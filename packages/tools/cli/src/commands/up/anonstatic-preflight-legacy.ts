/**
 * Static-hosting access-control pre-flight for the legacy `rayfin up` path.
 *
 * The obligations themselves — an explicit access posture in `rayfin.yml`, and
 * an auth SDK new enough to complete the resulting sign-in — are workflow steps
 * (`ensureStaticHostingPosture`, `ensureAuthSdk`) so every caller of
 * `runUpWorkflow` is held to them, not just the host that happens to prompt.
 *
 * The legacy path predates the workflow and orchestrates its own deploy, so it
 * cannot pick those steps up from `runUpWorkflow`. Rather than keeping a second
 * implementation of the invariants, it composes the same steps against the same
 * CLI services here. Kept out of `anonstatic-preflight.ts` so the v2 dry-run
 * planner does not drag the whole product-service graph in with it.
 *
 * Gated by the `cli-up-anonstatic` feature flag at the call site.
 */
import type { UserInteraction } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type {
  RayfinConfig,
  StaticHostingAssetAccess,
} from '@microsoft/rayfin-tools-common/_internal/config';
import {
  RECOMMENDED_STATIC_HOSTING_POSTURE,
  describeInvalidPostureError,
  describeMissingPostureError,
  describeOutdatedAuthSdk,
  describePosturePersistError,
  describeUnresolvedAuthSdk,
  ensureAuthSdk,
  ensureStaticHostingPosture,
  inspectStaticHostingPosture,
} from '@microsoft/rayfin-tools-common/_internal/workflows/up';

import { cliUserInteraction } from '../../adapters/user-interaction.js';
import { createCliAuthSdkService } from '../../rayfin-services/auth-sdk.js';
import { createCliStaticHostingService } from '../../rayfin-services/static-hosting.js';
import { type OutputMode, modeLog, modeWarn } from '../../utils/output-mode.js';

/** Inputs for {@link runAnonStaticPreflight}. */
export interface AnonStaticPreflightOptions {
  config: RayfinConfig;
  projectRoot: string;
  mode: OutputMode;
  /** Whether prompting is permitted (false under `--yes`, non-TTY, or CI). */
  interactive: boolean;
  /** Resolved `cli-up-anonstatic` gate. */
  enabled: boolean;
  /** Injected for tests; defaults to the CLI's inquirer-backed adapter. */
  ui?: UserInteraction;
}

/**
 * Outcome of the pre-flight.
 *
 * `ok` carries the resolved `assetAccess` so the caller threads it onto the
 * runtime-settings payload explicitly, rather than the pre-flight reaching into
 * the caller's config and mutating it. `undefined` means no posture applies —
 * the gate is off, or the project serves no static surface.
 */
export type AnonStaticPreflightOutcome =
  | { status: 'ok'; assetAccess?: StaticHostingAssetAccess }
  | { status: 'failed'; message: string };

/**
 * Resolve both obligations before the legacy path touches anything remote.
 *
 * Returns `ok` when the deploy may proceed. A `failed` outcome means nothing
 * remote has been attempted and the caller should abort.
 */
export async function runAnonStaticPreflight(
  options: AnonStaticPreflightOptions
): Promise<AnonStaticPreflightOutcome> {
  const { config, projectRoot, mode, interactive, enabled } = options;
  // Absent when the host cannot prompt, which makes the auth-SDK step return a
  // typed requirement instead of blocking on an answer that can never arrive.
  const ui = interactive ? (options.ui ?? cliUserInteraction) : undefined;
  const deps = {
    staticHosting: createCliStaticHostingService(),
    authSdk: createCliAuthSdkService(),
    ui,
  };
  const stepInput = { services: config.services, projectRoot };

  // The gate is applied here, not inside the steps: a step decides what is true
  // of a project, not whether the feature is switched on.
  if (!enabled) return { status: 'ok' };

  // The step validates and persists but never asks, so Layer 1 collects the
  // answer first. Nothing remote has happened yet either way.
  const chosen = await collectPostureAnswer(config, ui);
  const posture = await ensureStaticHostingPosture(
    { ...stepInput, postureAnswer: chosen },
    deps
  );
  switch (posture.status) {
    case 'invalid-posture':
      return {
        status: 'failed',
        message: describeInvalidPostureError(posture.value),
      };
    case 'answer-required':
      return { status: 'failed', message: describeMissingPostureError() };
    case 'persist-failed':
      return {
        status: 'failed',
        message: describePosturePersistError(posture.error),
      };
    default:
      break;
  }

  const assetAccess =
    posture.status === 'resolved' ? posture.assetAccess : undefined;
  if (posture.status === 'resolved' && posture.persisted) {
    modeLog(
      mode,
      `📋 Static-hosting asset access set to '${assetAccess}' in rayfin.yml`
    );
  }

  const authSdk = await ensureAuthSdk(stepInput, deps);
  switch (authSdk.status) {
    case 'unresolved':
      return {
        status: 'failed',
        message: describeUnresolvedAuthSdk(authSdk.reason),
      };
    case 'outdated':
      return {
        status: 'failed',
        message: describeOutdatedAuthSdk(authSdk.packages, authSdk.error),
      };
    case 'upgraded':
      modeLog(mode, `✅ Updated ${authSdk.packages.join(', ')}`);
      break;
    case 'ok':
      if (authSdk.notice) modeWarn(mode, `⚠️  ${authSdk.notice}`);
      break;
  }

  return { status: 'ok', assetAccess };
}

/**
 * Ask which posture to record, or `undefined` when there is nothing to ask.
 *
 * `protected` is listed first and therefore preselected by interaction
 * adapters, matching the recommended fail-closed posture.
 */
async function collectPostureAnswer(
  config: RayfinConfig,
  ui: UserInteraction | undefined
): Promise<StaticHostingAssetAccess | undefined> {
  if (!ui) return undefined;
  if (inspectStaticHostingPosture(config.services).state !== 'missing') {
    return undefined;
  }

  return ui.select<StaticHostingAssetAccess>(
    'Who should be able to open your deployed app?\n' +
      '  Either choice keeps Rayfin auth available inside the app.',
    [
      {
        label:
          'Only users with permissions to view the Fabric item will be able ' +
          'to retrieve any static assets. Visitors must sign in (recommended)',
        value: RECOMMENDED_STATIC_HOSTING_POSTURE,
      },
      {
        label:
          'Anyone with the link can be served static assets anonymously, no ' +
          'sign-in necessary',
        value: 'public',
      },
    ]
  );
}
