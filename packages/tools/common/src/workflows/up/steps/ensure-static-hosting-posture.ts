/**
 * `up` workflow step: resolve and record the static-hosting access posture.
 *
 * Builders author `assetAccess`, while the workload receives its existing
 * `anonymousAccess` contract from the shared runtime-settings serializer.
 *
 * This step owns the client half of that contract, so every caller of the
 * workflow satisfies it — not just the host that happens to prompt. It reports
 * whether the project already authored the value, turns one answer into it,
 * applies the protected default when it is missing, persists it to `rayfin.yml`, and returns the resolved value for the caller to
 * thread into the runtime-settings write. It never mutates the input config:
 * the value travels as an explicit output so nothing downstream depends on
 * shared modified state.
 *
 * Runs before any remote resource is resolved or created, so a project that
 * cannot answer fails while nothing has been published.
 */
import {
  STATIC_HOSTING_ASSET_ACCESS_VALUES,
  type RayfinConfig,
  type StaticHostingAssetAccess,
} from '../../../config/index.js';
import type { StaticHostingService } from '../../../services/static-hosting/index.js';
import type { Step } from '../../types.js';

/** The access postures onboarding can author. */
export type StaticHostingPosture = StaticHostingAssetAccess;

/** The values accepted by `services.staticHosting.assetAccess`. */
export const STATIC_HOSTING_POSTURE_VALUES = STATIC_HOSTING_ASSET_ACCESS_VALUES;

/** The posture recommended and preselected for interactive onboarding. */
export const RECOMMENDED_STATIC_HOSTING_POSTURE: StaticHostingPosture =
  'protected';

/** `rayfin.yml` path of the asset-access property. */
export const ASSET_ACCESS_YAML_PATH = 'services.staticHosting.assetAccess';

/** Whether a project needs posture onboarding before it can deploy. */
export type StaticHostingPostureState =
  /** Static hosting is off or absent — there is no served surface to gate. */
  | { state: 'not-applicable' }
  /** `assetAccess` is authored as a supported value; pass it through. */
  | { state: 'authored'; assetAccess: StaticHostingAssetAccess }
  /** Authored, but not as a supported value — the workload cannot act on it. */
  | { state: 'invalid'; value: unknown }
  /** Nothing authored — the project predates the contract and must choose. */
  | { state: 'missing' };

/**
 * Report whether `rayfin.yml` already carries an authored access posture.
 *
 * A value that is present but not a boolean — typically an env-var
 * interpolation that did not resolve — is reported as `invalid` rather than
 * accepted. Forwarding it would have the workload decide the access posture of
 * a live app from a string. An explicitly illegal pairing with `embedded.only`
 * is still left for the workload to reject; neither is silently rewritten.
 *
 * Exported so a host can decide what to ask before invoking the workflow; the
 * step re-reads it so the invariant does not depend on the host having done so.
 */
export function inspectStaticHostingPosture(
  services: RayfinConfig['services']
): StaticHostingPostureState {
  const staticHosting = services?.staticHosting;
  if (staticHosting?.enabled !== true) {
    return { state: 'not-applicable' };
  }

  const assetAccess = staticHosting.assetAccess;
  if (assetAccess !== undefined) {
    return STATIC_HOSTING_ASSET_ACCESS_VALUES.some(
      (supportedValue) => supportedValue === assetAccess
    )
      ? { state: 'authored', assetAccess }
      : { state: 'invalid', value: assetAccess };
  }

  return { state: 'missing' };
}

/** Inputs for {@link ensureStaticHostingPosture}. */
export interface EnsureStaticHostingPostureInput {
  /** The `services` block from `rayfin.yml`. Never mutated. */
  services: RayfinConfig['services'];
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /**
   * Posture chosen by the host before the workflow started. The step never
   * asks, so for an unauthored project this is the only way to supply one.
   */
  postureAnswer?: StaticHostingPosture;
}

/** Outcome of {@link ensureStaticHostingPosture}. */
export type EnsureStaticHostingPostureResult =
  /** Nothing to do: the gate is off, or the project serves no static surface. */
  | { status: 'skipped' }
  /**
   * A posture is in force. `persisted` is true when this step wrote it, false
   * when the project already authored it.
   */
  | {
      status: 'resolved';
      assetAccess: StaticHostingAssetAccess;
      persisted: boolean;
    }
  /** `assetAccess` is present but is not a supported value. */
  | { status: 'invalid-posture'; value: unknown }
  /** A posture must be chosen, but no answer was supplied and none can be asked for. */
  | { status: 'answer-required' }
  /** The posture was chosen but could not be written to `rayfin.yml`. */
  | { status: 'persist-failed'; error: string };

/** Capabilities {@link ensureStaticHostingPosture} composes. */
export interface EnsureStaticHostingPostureDeps {
  staticHosting: StaticHostingService;
}

/**
 * Resolve the access posture, persisting it when the project has none.
 *
 * Missing posture defaults to protected so older templates remain deployable
 * without silently making their hosted assets public.
 */
export const ensureStaticHostingPosture: Step<
  EnsureStaticHostingPostureInput,
  EnsureStaticHostingPostureResult,
  EnsureStaticHostingPostureDeps
> = async (input, { staticHosting }) => {
  const posture = inspectStaticHostingPosture(input.services);
  if (posture.state === 'invalid') {
    return { status: 'invalid-posture', value: posture.value };
  }

  switch (posture.state) {
    case 'not-applicable':
      return { status: 'skipped' };
    case 'authored':
      return {
        status: 'resolved',
        assetAccess: posture.assetAccess,
        persisted: false,
      };
    default:
      break;
  }

  const selected = input.postureAnswer ?? RECOMMENDED_STATIC_HOSTING_POSTURE;

  const persistence = await staticHosting.persistAssetAccess({
    projectRoot: input.projectRoot,
    assetAccess: selected,
  });
  if (persistence.status === 'failed') {
    return { status: 'persist-failed', error: persistence.error };
  }

  return { status: 'resolved', assetAccess: selected, persisted: true };
};

/** Overlay resolved asset access without mutating the loaded configuration. */
export function withAssetAccess(
  services: RayfinConfig['services'],
  assetAccess: StaticHostingAssetAccess | undefined
): RayfinConfig['services'] {
  if (assetAccess === undefined || !services?.staticHosting) {
    return services;
  }

  return {
    ...services,
    staticHosting: { ...services.staticHosting, assetAccess },
  };
}

/**
 * Message for a posture that is required but cannot be asked for.
 *
 * Automation must not have a posture chosen for it: silently defaulting would
 * change who can reach a live app without anyone checking that decision in.
 * The file edit is stated first because it is the only remedy that works in
 * every non-interactive case — `--yes` can be dropped, but a CI runner or a
 * `--json` invocation has nothing to drop.
 */
export function describeMissingPostureError(): string {
  return (
    `Static hosting is enabled but ${ASSET_ACCESS_YAML_PATH} is not set in rayfin.yml\n` +
    '   An explicit access posture is required to publish a static-hosted app.\n' +
    '   Add it under services.staticHosting:\n' +
    '     assetAccess: protected   # Visitors must sign in with Fabric before hosted assets load (recommended)\n' +
    '     assetAccess: public      # Anyone with the link can load the hosted assets\n' +
    '   Or run `rayfin up` in an interactive terminal, without --yes or --json, to choose.'
  );
}

/**
 * Message for an `assetAccess` value that is not supported.
 *
 * Almost always an unresolved `${VAR}` interpolation, so the offending value is
 * echoed back rather than described.
 */
export function describeInvalidPostureError(value: unknown): string {
  return (
    `${ASSET_ACCESS_YAML_PATH} in rayfin.yml must be protected or public, but is ${JSON.stringify(value)}\n` +
    '   An access posture decides who can open your deployed app, so it cannot be guessed.\n' +
    '   If this came from an environment variable, check that it resolves to protected or public.'
  );
}

/** Message for a chosen posture that could not be written to `rayfin.yml`. */
export function describePosturePersistError(error: string): string {
  return (
    `${error}\n` +
    '   Check that rayfin/rayfin.yml exists and is writable, then re-run.'
  );
}

/** One-line summary of the posture a dry run would author. */
export function describePlannedPosture(
  _state: StaticHostingPostureState['state'],
  interactive: boolean
): string {
  return interactive
    ? `Prompt for the static-hosting access posture and write ${ASSET_ACCESS_YAML_PATH} to rayfin.yml`
    : `Default ${ASSET_ACCESS_YAML_PATH} to protected and write it to rayfin.yml`;
}
