import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import * as vscode from 'vscode';

/**
 * VS Code cannot yet run the auth-SDK compatibility preflight required by
 * static-hosting access control.
 *
 * Scoped to full deployment. A content-only deploy preserves whatever the last
 * `rayfin up` recorded rather than applying a posture, so it has nothing to
 * validate and is not gated.
 */
export function assertStaticHostingAccessSupported(config: RayfinConfig): void {
  const staticHosting = config.services.staticHosting;
  if (
    staticHosting?.enabled !== true ||
    staticHosting.assetAccess === undefined
  ) {
    return;
  }

  throw new Error(
    vscode.l10n.t(
      'Static-hosting access configuration is not supported by the VS Code deployment flow yet. Run `rayfin up` in a terminal so Rayfin can validate and upgrade @microsoft/rayfin-auth before deploying.'
    )
  );
}
