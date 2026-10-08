/**
 * CLI implementation of the {@link AuthSdkService} product-service contract.
 *
 * A thin delegation to the existing auth SDK helpers: module resolution, the
 * version floor, and running the project's own package manager all stay in
 * `commands/up/auth-sdk-preflight.ts`. This adapter's job is to resolve the
 * frontend package directory from `services.staticHosting.path` and map the
 * helpers' outcomes onto the universal result union.
 *
 * The path is resolved through {@link resolveServiceRoot} — the same guard the
 * static deploy uses — so a `path` that is absolute or escapes the project root
 * is rejected before the package manager is run anywhere outside the project.
 */
import type {
  AuthSdkInspection,
  AuthSdkRequest,
  AuthSdkService,
  AuthSdkUpgrade,
} from '@microsoft/rayfin-tools-common/_internal/services/auth-sdk';

import {
  AUTH_SDK_PACKAGE,
  assertAuthSdkMinVersionResolved,
  inspectAuthSdk,
  upgradeRayfinPackages,
} from '../commands/up/auth-sdk-preflight.js';
import { resolveServiceRoot } from '../utils/config-utils.js';
import { findDeclaredRayfinPackages } from '../utils/package-versions.js';

/** Construct the CLI-host {@link AuthSdkService}. */
export function createCliAuthSdkService(): AuthSdkService {
  return {
    async inspect(request: AuthSdkRequest): Promise<AuthSdkInspection> {
      // No floor has been chosen yet, so there is nothing meaningful to compare
      // against. Report that rather than comparing every version against a
      // placeholder, which would silently pass each of them as current.
      const unresolvedFloor = assertAuthSdkMinVersionResolved();
      if (unresolvedFloor) {
        return { state: 'unknown-floor', reason: unresolvedFloor };
      }

      const packageDir = resolveFrontendPackageDir(request);
      const inspection = inspectAuthSdk(packageDir);
      switch (inspection.state) {
        case 'absent':
        case 'current':
          return { state: 'satisfied' };
        case 'unresolved':
          return { state: 'unresolved', reason: inspection.reason };
        case 'outdated':
          return {
            state: 'outdated',
            packages: resolveUpgradeSet(packageDir),
          };
      }
    },

    async upgrade(
      request: AuthSdkRequest & { packages: string[] }
    ): Promise<AuthSdkUpgrade> {
      const result = upgradeRayfinPackages(
        resolveFrontendPackageDir(request),
        request.packages
      );
      return result.status === 'upgraded'
        ? { status: 'upgraded' }
        : { status: 'failed', error: result.error };
    },
  };
}

/** Directory whose installed dependencies this deploy would ship. */
function resolveFrontendPackageDir(request: AuthSdkRequest): string {
  return resolveServiceRoot(
    request.projectRoot,
    'staticHosting',
    request.services?.staticHosting?.path ?? '.'
  );
}

/**
 * Every Rayfin package that must move with the SDK.
 *
 * They ship in lockstep, so raising only the SDK can leave the package that
 * pulled it in on an older major. When no ancestor manifest declares any Rayfin
 * package the SDK is purely transitive, and it alone is what has to land.
 */
function resolveUpgradeSet(packageDir: string): string[] {
  return findDeclaredRayfinPackages(packageDir)?.packages ?? [AUTH_SDK_PACKAGE];
}
