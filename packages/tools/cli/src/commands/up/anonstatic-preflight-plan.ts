/**
 * `--dry-run` plan for the `rayfin up` static-hosting access-control pre-flight.
 *
 * The obligations themselves — an explicit access posture in `rayfin.yml`, and
 * an auth SDK new enough to complete the resulting sign-in — are workflow steps
 * (`ensureStaticHostingPosture`, `ensureAuthSdk`). This module only describes
 * what those steps would do, which is Layer 1 rendering.
 *
 * Gated by the `cli-up-anonstatic` feature flag at the call sites.
 */
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  ASSET_ACCESS_YAML_PATH,
  describePlannedPosture,
  inspectStaticHostingPosture,
} from '@microsoft/rayfin-tools-common/_internal/workflows/up';

import { resolveServiceRoot } from '../../utils/config-utils.js';
import { findDeclaredRayfinPackages } from '../../utils/package-versions.js';

import {
  AUTH_SDK_PACKAGE,
  assertAuthSdkMinVersionResolved,
  inspectAuthSdk,
} from './auth-sdk-preflight.js';

/**
 * One planned pre-flight operation.
 *
 * `blocking` carries whether a real `up` would stop here, so the renderer can
 * mark it and the command can exit non-zero. Encoding that in the text would
 * force callers to parse prose to learn whether the plan is achievable.
 */
export interface PreflightPlanEntry {
  /** What the pre-flight would do, or the obligation it could not meet. */
  text: string;
  /** Whether a real `up` would fail here. */
  blocking: boolean;
}

/**
 * Lines describing what the pre-flight would do, for `--dry-run`.
 *
 * Reports intent only: no prompt, no file write, no package manager, no
 * network. Takes `interactive` so the plan models the same branch the real run
 * would take rather than always promising a prompt. Returns an empty list when
 * the gate is off or nothing would change.
 */
export function describeAnonStaticPreflight(
  config: RayfinConfig,
  projectRoot: string,
  enabled: boolean,
  interactive: boolean
): PreflightPlanEntry[] {
  if (!enabled) return [];

  const lines: PreflightPlanEntry[] = [];
  const posture = inspectStaticHostingPosture(config.services);
  if (posture.state === 'not-applicable') return lines;

  if (posture.state === 'invalid') {
    lines.push({
      text: `${ASSET_ACCESS_YAML_PATH} in rayfin.yml is not protected or public`,
      blocking: true,
    });
    return lines;
  }

  if (posture.state === 'missing') {
    lines.push({
      text: describePlannedPosture(posture.state, interactive),
      blocking: false,
    });
  }

  const outdated = planRayfinPackageUpgrade(config, projectRoot);
  if (outdated) {
    lines.push(
      interactive
        ? {
            text: `Ask to update ${outdated.join(', ')} to a supported version`,
            blocking: false,
          }
        : {
            text: `${outdated.join(', ')} are older than static-hosting access control requires and this run cannot prompt`,
            blocking: true,
          }
    );
  }

  return lines;
}

/** The Rayfin packages a run would offer to update, or `undefined` for none. */
function planRayfinPackageUpgrade(
  config: RayfinConfig,
  projectRoot: string
): string[] | undefined {
  if (assertAuthSdkMinVersionResolved()) return undefined;

  const packageDir = resolveServiceRoot(
    projectRoot,
    'staticHosting',
    config.services?.staticHosting?.path ?? '.'
  );
  if (inspectAuthSdk(packageDir).state !== 'outdated') return undefined;

  return findDeclaredRayfinPackages(packageDir)?.packages ?? [AUTH_SDK_PACKAGE];
}
