import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  DEPLOY_CLIENT_VERSION_KEY,
  buildRuntimeSettingsPayload,
} from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import { translateStaticHostingAccessError } from '@microsoft/rayfin-tools-common/_internal/services/runtime-settings';

import { fabricFetch, throwIfNotOk } from './http-client.js';
import { HttpError, withRetry } from './retry-utils.js';
import { getPackageVersion } from './version.js';

/** `packageVersions` key carrying the CLI that performed the deployment. */
export const CLI_VERSION_KEY = DEPLOY_CLIENT_VERSION_KEY;

/**
 * Sentinel {@link getPackageVersion} returns when the CLI cannot read its own
 * manifest. The control plane treats an unparsable version as absent, so it
 * must not reach the wire on a deploy the gate applies to.
 */
const UNKNOWN_CLI_VERSION = 'Unknown';

/**
 * Transient HTTP statuses worth retrying. Mirrors the BaaS server-side
 * `RetryHelper.IsRetryableHttpStatusCode` allowlist so client and server agree
 * on what "transient" means. Everything else — notably 4xx permission denials
 * like 403 (NO_BUILD_PERMISSION) and 404 (WorkspaceNotFound) — is terminal and
 * must fail fast instead of being hammered for the full backoff schedule.
 */
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/**
 * POSTs runtime settings (services config) to the Rayfin workload endpoint.
 * Retries on transient failures with exponential backoff.
 * Used for both the initial apply and subsequent updates (e.g. adding redirect URIs).
 *
 * Wire shape matches the host's `ServiceSettings` model: `auth`, `data`,
 * `storage`, `staticHosting`, `functions`, and `connectors` are sibling
 * top-level keys. In `rayfin.yml`, `connectors` lives at the same level as
 * `services` (not nested under it), so we merge them here before sending.
 *
 * `rayfin.yml` carries `connectors` as an array of self-describing entries
 * (`{ name, type, ... }`), but the host's `ServiceSettings.Connectors` is a
 * `Dictionary<string, ConnectorSettings>` keyed by name, with the entry's
 * kind under `connector:` (not `type:`). We transform array → map and rename
 * `type` → `connector` here, at the wire boundary, so the in-memory and
 * on-disk shapes stay array-of-objects everywhere else.
 *
 * Every write also declares `packageVersions`, which the control plane gates on
 * to detect a CLI too old to author an access posture. It is attached here
 * rather than in the config so it can never be persisted to `rayfin.yml`: it
 * describes the deployment happening now, not something the Builder chose.
 */
export async function postRuntimeSettings(
  itemEndpoint: string,
  payload: RayfinConfig['services'],
  authorizationHeader: string,
  verbose: (...args: any[]) => void,
  label = 'runtime-settings',
  extraHeaders?: Record<string, string>,
  connectors?: RayfinConfig['connectors'],
  packageVersions?: Record<string, string>,
  diagnostics?: Diagnostics
): Promise<void> {
  const cliVersion = getPackageVersion();

  // Fail here, where the real cause is still known. Sending the sentinel would
  // surface as a control-plane 400 telling the Builder to upgrade a CLI that is
  // already current. Scoped to static-hosting deploys because those are the
  // only writes the version gate applies to.
  if (
    payload?.staticHosting?.enabled === true &&
    (!cliVersion || cliVersion === UNKNOWN_CLI_VERSION)
  ) {
    throw new Error(
      'Could not determine the Rayfin CLI version from its own package.json, ' +
        'which a static-hosted deploy must declare.\n' +
        '   Reinstall @microsoft/rayfin-cli, then re-run.'
    );
  }

  const wirePayload = buildRuntimeSettingsPayload({
    services: payload,
    connectors,
    packageVersions,
    clientVersion: cliVersion,
  });
  await withRetry(
    async () => {
      const settingsUrl = `${itemEndpoint}/__private/projectRuntimeSettings`;
      verbose(`[${label}] POST`, settingsUrl);

      const resp = await fabricFetch(
        settingsUrl,
        {
          method: 'POST',
          headers: {
            Authorization: authorizationHeader,
            'Content-Type': 'application/json',
            ...extraHeaders,
          },
          body: JSON.stringify(wirePayload),
        },
        diagnostics
      );
      verbose(`[${label}] Response: ${resp.status} ${resp.statusText}`);
      const respBody = await throwIfNotOk(
        resp,
        'Runtime settings sync failed',
        translateStaticHostingAccessError
      );
      verbose(`[${label}] Response body:`, respBody);
    },
    {
      label,
      verbose: (...args) => {
        diagnostics?.debug({
          area: 'runtime-settings.retry',
          message: args.map(String).join(' '),
        });
        verbose(...args);
      },
      // Retry network/timeout errors and transient statuses only. Terminal 4xx
      // responses (403 build-permission denial, 404 workspace-not-found, etc.)
      // short-circuit immediately rather than retrying for ~30s before failing.
      shouldRetry: (error) =>
        !(error instanceof HttpError) ||
        RETRYABLE_STATUS_CODES.includes(error.statusCode),
    }
  );
}
