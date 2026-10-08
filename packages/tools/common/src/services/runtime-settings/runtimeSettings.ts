import {
  STATIC_HOSTING_ASSET_ACCESS_VALUES,
  type RayfinConfig,
  type StaticHostingAssetAccess,
} from '../../config/index.js';

const ANONYMOUS_ACCESS_BY_ASSET_ACCESS: Record<
  StaticHostingAssetAccess,
  boolean
> = {
  protected: false,
  public: true,
};

/** Service configuration accepted by the workload runtime-settings endpoint. */
export type RuntimeSettingsServices = Omit<
  RayfinConfig['services'],
  'staticHosting'
> & {
  staticHosting?: Omit<
    NonNullable<RayfinConfig['services']['staticHosting']>,
    'assetAccess'
  > & {
    anonymousAccess?: boolean;
  };
};

/**
 * Converts Builder-facing service configuration to the workload wire shape.
 */
export function toRuntimeSettingsServices(
  services: RayfinConfig['services']
): RuntimeSettingsServices {
  const staticHosting = services.staticHosting;
  if (!staticHosting) {
    return { ...services };
  }

  const {
    assetAccess,
    anonymousAccess: legacyAnonymousAccess,
    ...wireStaticHosting
  } = staticHosting as typeof staticHosting & {
    anonymousAccess?: unknown;
  };
  if (
    assetAccess !== undefined &&
    !STATIC_HOSTING_ASSET_ACCESS_VALUES.some(
      (supportedValue) => supportedValue === assetAccess
    )
  ) {
    throw new Error(
      `services.staticHosting.assetAccess must be "protected" or "public", but is ${JSON.stringify(assetAccess)}. ` +
        'If this came from an environment variable, check that it resolves to protected or public.'
    );
  }

  return {
    ...services,
    staticHosting: {
      ...wireStaticHosting,
      ...(assetAccess === undefined
        ? typeof legacyAnonymousAccess === 'boolean'
          ? { anonymousAccess: legacyAnonymousAccess }
          : staticHosting.enabled === true
            ? { anonymousAccess: false }
            : {}
        : {
            anonymousAccess: ANONYMOUS_ACCESS_BY_ASSET_ACCESS[assetAccess],
          }),
    },
  };
}

/** Inputs for {@link preserveRecordedRuntimeSettings}. */
export interface PreserveRecordedRuntimeSettingsInput {
  /** Settings the workload currently has recorded, from a settings read. */
  recorded: RuntimeSettingsServices;
  /** Local `services` supplying the auth block this update is changing. */
  services: RayfinConfig['services'];
  /** Package versions describing the deploy performing the update. */
  packageVersions: Record<string, string>;
}

/**
 * Body for an update that must not restate the access posture.
 *
 * A content-only deploy changes redirect URIs, not who may open the app, so it
 * sends back what the workload already recorded and overlays only `auth` and
 * the current `packageVersions`. Posting the local `services` instead would let
 * a stale working copy silently republish an old posture over the deployed one.
 */
export function preserveRecordedRuntimeSettings(
  input: PreserveRecordedRuntimeSettingsInput
): RuntimeSettingsServices & { packageVersions: Record<string, string> } {
  const { recorded, services, packageVersions } = input;
  return { ...recorded, auth: services.auth, packageVersions };
}
