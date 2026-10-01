import { execFile } from 'child_process';

import type { AuthSession } from '@microsoft/rayfin-tools-common/_internal/services/auth';
import {
  BoundedPollingLicenseResolutionStrategy,
  FabricLicenseProbe,
  FabricUserLicenseService,
  noOpUserLicenseService,
  type ExternalNavigation,
  type LicenseClock,
  type LicenseProbe,
  type UserLicenseService,
} from '@microsoft/rayfin-tools-common/_internal/services/user-license';

import { authFromSession } from '../adapters/auth.js';
import { createCliHttp } from '../adapters/http.js';
import { getFabricScopes } from '../auth/constants.js';
import { getFabricSettings } from '../config/constants.js';

export const LICENSE_ASSIGNED_NOTICE =
  'A Fabric Free license was added to your account.\n' +
  'Learn more: https://go.microsoft.com/fwlink/?linkid=2147433\n' +
  'Privacy statement: https://go.microsoft.com/fwlink/?linkid=521839#mainnoticetoendusersmodule';

export const LICENSE_ENROLLMENT_STARTED_NOTICE =
  'Opening the browser to initiate Fabric Free license signup. Waiting for license acquisition to complete...';

export const cliExternalNavigation: ExternalNavigation = {
  open(url) {
    return new Promise<void>((resolve, reject) => {
      const browser = process.env['BROWSER'];
      const command = browser
        ? browser
        : process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'rundll32.exe'
            : 'xdg-open';
      const args =
        process.platform === 'win32' && !browser
          ? ['url.dll,FileProtocolHandler', url]
          : [url];
      execFile(command, args, { windowsHide: true }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  },
};

export interface CreateCliUserLicenseServiceOptions {
  provider: string;
  session?: AuthSession;
  navigation?: ExternalNavigation;
  probe?: LicenseProbe;
  clock?: LicenseClock;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  notify?: (message: string) => void | Promise<void>;
}

export async function createCliUserLicenseService(
  options: CreateCliUserLicenseServiceOptions
): Promise<UserLicenseService> {
  if (options.provider !== 'fabric') {
    return noOpUserLicenseService;
  }

  if (!options.session) {
    throw new Error(
      'A resolved authenticated session is required for Fabric license checks.'
    );
  }
  if (options.session.identityType !== 'user') {
    return noOpUserLicenseService;
  }

  const settings = getFabricSettings();
  const probe =
    options.probe ??
    new FabricLicenseProbe({
      http: createCliHttp(authFromSession(options.session), getFabricScopes()),
      fabricApiBaseUrl: settings.fabricApiBaseUrl,
    });

  return new FabricUserLicenseService({
    probe,
    navigation: options.navigation ?? cliExternalNavigation,
    resolution: new BoundedPollingLicenseResolutionStrategy({
      clock: options.clock,
      intervalMs: options.pollIntervalMs,
      timeoutMs: options.pollTimeoutMs,
    }),
    fabricPortalUrl: settings.fabricPortalUrl,
    ...(options.notify
      ? {
          onEnrollmentStarted: () =>
            options.notify?.(LICENSE_ENROLLMENT_STARTED_NOTICE),
        }
      : {}),
    ...(options.notify
      ? {
          onLicenseAssigned: () => options.notify?.(LICENSE_ASSIGNED_NOTICE),
        }
      : {}),
  });
}
