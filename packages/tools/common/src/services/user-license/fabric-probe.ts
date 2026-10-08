import {
  abortSignalFromCancellationToken,
  type CancellationToken,
} from '../../adapters/cancellation.js';
import type { Http } from '../../adapters/http.js';

import type {
  LicenseProbe,
  LicenseProbeOptions,
  LicenseProbeOutcome,
} from './types.js';
import { UserLicenseError } from './types.js';

const USER_NOT_LICENSED = 'usernotlicensed';
const AUTO_LICENSE_HEADER = 'X-PowerBI-Auto-License-Info';
const AUTO_LICENSE_SUPPORTED = 'AutoLicenseAssignmentSupported';
const AUTO_LICENSE_SUCCEEDED = 'autolicenseassignmentsucceeded';
const AUTO_LICENSE_DISABLED = 'autolicenseassignmentdisabledbytenant';

export interface FabricLicenseProbeOptions {
  http: Http;
  fabricApiBaseUrl: string;
}

function resolveClusterDiscoveryUrl(fabricApiBaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(fabricApiBaseUrl);
  } catch (error) {
    throw new UserLicenseError(
      'fabric_license_probe_failed',
      'Unable to resolve the cluster discovery URL from the Fabric API base URL: expected base url to end with "/v1".',
      { cause: error }
    );
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.at(-1)?.toLowerCase() !== 'v1') {
    throw new UserLicenseError(
      'fabric_license_probe_failed',
      'The Fabric API base URL must end with /v1.'
    );
  }

  segments.splice(-1, 1, 'metadata', 'cluster');
  url.pathname = `/${segments.join('/')}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class FabricLicenseProbe implements LicenseProbe {
  constructor(private readonly options: FabricLicenseProbeOptions) {}

  async probe(
    signal: CancellationToken,
    options: LicenseProbeOptions = {}
  ): Promise<LicenseProbeOutcome> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.allowAutoLicenseAssignment) {
      headers[AUTO_LICENSE_HEADER] = AUTO_LICENSE_SUPPORTED;
    }

    const clusterDiscoveryUrl = resolveClusterDiscoveryUrl(
      this.options.fabricApiBaseUrl
    );
    let response: Response;
    const requestCancellation = abortSignalFromCancellationToken(signal);
    try {
      response = await this.options.http.fetch(clusterDiscoveryUrl, {
        method: 'GET',
        headers,
        signal: requestCancellation.signal,
      });
    } catch (error) {
      if (signal.isCancellationRequested) {
        throw error;
      }
      throw new UserLicenseError(
        'fabric_license_probe_failed',
        'Fabric license probe request failed.',
        { cause: error }
      );
    } finally {
      requestCancellation.dispose();
    }

    const autoLicenseInfo = response.headers
      .get(AUTO_LICENSE_HEADER)
      ?.trim()
      .toLowerCase();
    if (response.ok && autoLicenseInfo === AUTO_LICENSE_SUCCEEDED) {
      return { outcome: 'license_assigned' };
    }
    if (response.ok) {
      return { outcome: 'licensed' };
    }

    const errorInfo = response.headers.get('X-PowerBI-Error-Info');
    if (
      [401, 403, 404].includes(response.status) &&
      errorInfo?.trim().toLowerCase() === USER_NOT_LICENSED
    ) {
      if (autoLicenseInfo === AUTO_LICENSE_DISABLED) {
        return { outcome: 'auto_license_disabled' };
      }
      return { outcome: 'unlicensed' };
    }

    throw new UserLicenseError(
      'fabric_license_probe_failed',
      `Fabric license probe failed with HTTP ${response.status}.`
    );
  }
}
