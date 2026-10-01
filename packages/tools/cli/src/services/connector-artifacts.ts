import { existsSync, rmSync } from 'fs';
import { join } from 'path';

// ── removeConnectorArtifacts ─────────────────────────────────────────

export interface RemoveConnectorArtifactsOptions {
  /**
   * Skip deletion of `rayfin/connectors/<name>/` even if it exists.
   * The legacy `.temp/sources/<name>/` directory is still removed for
   * back-compat cleanup. Default `false`.
   */
  keepConnectorDir?: boolean;
}

export interface RemovedConnectorArtifacts {
  /** `true` when `rayfin/connectors/<name>/` was present and deleted. */
  connectorDirRemoved: boolean;
  /**
   * `true` when the legacy `rayfin/.temp/sources/<name>/` directory was
   * present and deleted. Schema metadata is now written under
   * `rayfin/connectors/<name>/metadata.json`; this branch only scrubs
   * leftovers from older project layouts.
   */
  tempDirRemoved: boolean;
}

/**
 * Delete the on-disk artifacts owned by a single connector:
 *   - `rayfin/connectors/<name>/` (scaffold, entity files, metadata.json)
 *   - `rayfin/.temp/sources/<name>/` (legacy metadata location — older
 *     projects only; current discovery writes inside the connector dir)
 *
 * Never mutates `rayfin.yml`; the caller owns YAML changes. Safe to call when
 * either directory is absent — returns flags indicating what was actually
 * removed so the caller can log accurately.
 */
export function removeConnectorArtifacts(
  projectRoot: string,
  connectorName: string,
  options: RemoveConnectorArtifactsOptions = {}
): RemovedConnectorArtifacts {
  const { keepConnectorDir = false } = options;

  const connectorDir = join(projectRoot, 'rayfin', 'connectors', connectorName);
  const tempDir = join(
    projectRoot,
    'rayfin',
    '.temp',
    'sources',
    connectorName
  );

  let connectorDirRemoved = false;
  if (!keepConnectorDir && existsSync(connectorDir)) {
    rmSync(connectorDir, { recursive: true, force: true });
    connectorDirRemoved = true;
  }

  let tempDirRemoved = false;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDirRemoved = true;
  }

  return { connectorDirRemoved, tempDirRemoved };
}
