/**
 * `up` workflow step: hold the deploy to the supported Rayfin auth SDK floor.
 *
 * Static-hosting access control changes how a deployed app acquires its
 * session, so an app whose frontend still bundles an older
 * `@microsoft/rayfin-auth` can deploy successfully and then fail to sign anyone
 * in. This step checks the installed dependency before anything is published
 * and upgrades it in place when the Builder consents.
 *
 * Lives in the workflow rather than the command layer so the invariant holds
 * for every caller, and so the package-manager invocation happens behind an
 * injected service ({@link AuthSdkService}) that returns a typed result instead
 * of being run inline by whichever host got there first.
 *
 * Silent when the project does not depend on the SDK or is already current, so
 * a routine deploy pays nothing for this check.
 */
import type { UserInteraction } from '../../../adapters/index.js';
import type { RayfinConfig } from '../../../config/index.js';
import type { AuthSdkService } from '../../../services/auth-sdk/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link ensureAuthSdk}. */
export interface EnsureAuthSdkInput {
  /** The `services` block from `rayfin.yml`, used to locate the frontend package. */
  services: RayfinConfig['services'];
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /**
   * Consent to change the project's dependency versions, already collected by a
   * host that asks ahead of the workflow. When absent the step asks through
   * {@link UserInteraction}.
   */
  upgradeApproved?: boolean;
}

/** Outcome of {@link ensureAuthSdk}. */
export type EnsureAuthSdkResult =
  /** Nothing to do, or the check could not run. `notice` explains a skip. */
  | { status: 'ok'; notice?: string }
  /** The named packages were raised to the floor. */
  | { status: 'upgraded'; packages: string[] }
  /**
   * The packages are behind the floor and this run will not fix them — consent
   * was withheld, could not be asked for, or the upgrade failed. `packages`
   * names every package the Builder must move; `error` carries the package
   * manager's failure when there was one.
   */
  | { status: 'outdated'; packages: string[]; error?: string }
  /** The effective installed version could not be determined. */
  | { status: 'unresolved'; reason: string };

/** Capabilities {@link ensureAuthSdk} composes. */
export interface EnsureAuthSdkDeps {
  authSdk: AuthSdkService;
  /** Absent on non-interactive hosts; its absence withholds upgrade consent. */
  ui?: UserInteraction;
}

/**
 * Inspect the installed auth SDK and, with consent, raise it to the floor.
 *
 * An outdated SDK is returned as a typed outcome rather than thrown: the caller
 * decides whether an app that cannot complete sign-in is worth blocking, and
 * nothing remote has been touched either way.
 */
export const ensureAuthSdk: Step<
  EnsureAuthSdkInput,
  EnsureAuthSdkResult,
  EnsureAuthSdkDeps
> = async (input, { authSdk, ui }) => {
  // A data-only deployment ships no frontend, so no access-control contract
  // applies and there is nothing to hold to the floor. Checking anyway would
  // have it modify a manifest, or fail on an unresolved SDK, for a deploy the
  // gate never covers.
  if (input.services?.staticHosting?.enabled !== true) {
    return { status: 'ok' };
  }

  const request = {
    projectRoot: input.projectRoot,
    services: input.services,
  };
  const inspection = await authSdk.inspect(request);

  switch (inspection.state) {
    case 'satisfied':
      return { status: 'ok' };
    case 'unknown-floor':
      return { status: 'ok', notice: inspection.reason };
    case 'unresolved':
      return { status: 'unresolved', reason: inspection.reason };
    default:
      break;
  }

  const { packages } = inspection;
  const approved = input.upgradeApproved ?? (await askToUpgrade(ui, packages));
  if (!approved) {
    return { status: 'outdated', packages };
  }

  const upgrade = await authSdk.upgrade({ ...request, packages });
  return upgrade.status === 'upgraded'
    ? { status: 'upgraded', packages }
    : { status: 'outdated', packages, error: upgrade.error };
};

/**
 * Ask before changing the Builder's dependency versions.
 *
 * Names every Rayfin package it would move rather than just the SDK: the
 * Builder may have pinned a provider package and never mentioned the SDK, and
 * raising one without the others produces a graph that installs cleanly and
 * then fails at runtime.
 */
async function askToUpgrade(
  ui: UserInteraction | undefined,
  packages: string[]
): Promise<boolean> {
  if (!ui) return false;

  return ui.confirm(
    'Update these Rayfin packages to a supported version?\n' +
      packages.map((name) => `     • ${name}`).join('\n') +
      '\n ',
    { default: true }
  );
}

/**
 * Message for packages below the floor that this run will not fix itself.
 *
 * Names every package rather than just the SDK: the Builder may have pinned a
 * provider package and never mentioned the SDK, and raising one without the
 * others produces a graph that installs cleanly and then fails at runtime.
 */
export function describeOutdatedAuthSdk(
  packages: string[],
  error?: string
): string {
  return (
    (error ? `${error}\n` : '') +
    'Some packages are older than the ones static-hosting access control requires.\n' +
    '   Rayfin packages ship as a set, so update these together — raising one on its own\n' +
    '   leaves whatever depends on it behind:\n' +
    packages.map((name) => `     • ${name}`).join('\n') +
    '\n   Update them to a supported version, then re-run.'
  );
}

/** Message for an installed version that could not be determined. */
export function describeUnresolvedAuthSdk(reason: string): string {
  return (
    `${reason}.\n` +
    "   Install the project's dependencies so the Rayfin auth packages can be checked, then re-run."
  );
}
