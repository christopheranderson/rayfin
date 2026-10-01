/**
 * The `projectRuntimeSettings` wire payload, shared by every deploy client.
 *
 * Both the CLI and the VS Code extension write runtime settings to the same
 * workload endpoint, so the body they send — and the client identity the
 * workload gates on — is one contract rather than one per host. Assembling it
 * here keeps a host from shipping a body the workload silently rejects: when
 * static-hosting access control is enforced, a write with no
 * {@link DEPLOY_CLIENT_VERSION_KEY} entry is refused with HTTP 400, and the
 * remedy it names ("upgrade the CLI") is useless to a host that is not the CLI.
 *
 * Hosts still own transport: acquiring tokens, retry, and headers stay in each
 * host's client. This module only maps in-memory config to the wire shape.
 */
import type { RayfinConfig } from '../../config/index.js';
import { toRuntimeSettingsServices } from '../../services/runtime-settings/index.js';

/**
 * `packageVersions` key carrying the identity of the client that wrote the
 * settings.
 *
 * Named for the CLI because the CLI was the only deploy client when the
 * workload's gate shipped, and the workload reads this exact key. Any other
 * host declares the version of the deploy logic it embeds under the same key —
 * the value identifies the contract version being spoken, not the executable.
 */
export const DEPLOY_CLIENT_VERSION_KEY = '@microsoft/rayfin-cli';

/** Inputs for {@link buildRuntimeSettingsPayload}. */
export interface RuntimeSettingsPayloadInput {
  /** The `services` block from `rayfin.yml`, sent as the settings body. */
  services: RayfinConfig['services'];
  /**
   * The `connectors` block from `rayfin.yml`. When non-empty it is merged into
   * the payload as a **sibling** of the service keys (not nested under
   * `services`). Omitted or empty connectors leave the payload unchanged.
   */
  connectors?: RayfinConfig['connectors'];
  /**
   * Versions of the Rayfin packages this deploy ships (e.g. the auth SDK
   * bundled into the frontend). The client identity is added separately and
   * always wins, so a stale entry here cannot misreport who performed the write.
   */
  packageVersions?: Record<string, string>;
  /** Version of the deploy client, written under {@link DEPLOY_CLIENT_VERSION_KEY}. */
  clientVersion: string;
}

/**
 * Drop the local `connectors` opt-in from a services block.
 *
 * `services.connectors.enabled` is a deprecated no-op, but existing
 * `rayfin.yml` files still carry it. The workload's `connectors` is a map of
 * `ConnectorSettings`, so it rejects a boolean there and fails the whole
 * settings write. The strip is therefore still required.
 */
export function withoutLocalConnectorsOptIn<T extends object | undefined>(
  services: T
): T {
  if (!services) return services;
  const { connectors: _localOptIn, ...rest } = services as Record<
    string,
    unknown
  >;
  return rest as T;
}

/**
 * Map config to the workload's `ServiceSettings` wire shape.
 *
 * `rayfin.yml` carries `connectors` as an array of self-describing entries
 * (`{ name, type, ... }`), but the workload models them as a map keyed by name
 * with the entry's kind under `connector`. The transform happens here, at the
 * wire boundary, so the in-memory and on-disk shapes stay array-of-objects
 * everywhere else. The unrelated `services.connectors` opt-in flag is dropped
 * here for the same reason — it shares a name with the map but not a shape.
 * Builder-facing `staticHosting.assetAccess` is likewise translated to the
 * workload's existing `staticHosting.anonymousAccess` boolean here.
 *
 * `packageVersions` describes the deployment happening now, not something the
 * Builder chose, so it is attached here and never persisted to `rayfin.yml`.
 */
export function buildRuntimeSettingsPayload(
  input: RuntimeSettingsPayloadInput
): Record<string, unknown> {
  const { services, connectors, packageVersions, clientVersion } = input;

  const connectorsWire =
    connectors && connectors.length > 0
      ? Object.fromEntries(
          connectors.map(({ name, type, ...rest }) => [
            name,
            { connector: type, ...rest },
          ])
        )
      : undefined;

  // `services.connectors.enabled` is a deprecated no-op that older projects may
  // still have in `rayfin.yml`. The workload has no boolean there and rejects
  // one, since its `connectors` is the map built above. The two happen to share
  // a name, so the stale local flag must not reach the wire.
  const wireServices = withoutLocalConnectorsOptIn(services);

  return {
    ...toRuntimeSettingsServices(wireServices),
    ...(connectorsWire ? { connectors: connectorsWire } : {}),
    // Written last so a stale checked-in value cannot misreport which client ran.
    packageVersions: {
      ...packageVersions,
      [DEPLOY_CLIENT_VERSION_KEY]: clientVersion,
    },
  };
}
