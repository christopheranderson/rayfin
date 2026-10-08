/**
 * Deployment-registry state-equivalence parity test.
 *
 * The dual-path migration's contract is that v2 produces the same *state* as
 * the legacy path, even when output bytes differ. The registry record written
 * to `rayfin/.deployments.json` is the durable state for `up`, so this test
 * pins it: writing through the v2 {@link createCliDeploymentRegistryService}
 * (the path the workflow's `persist-deployment` step takes) must yield a
 * registry record field-equivalent to the legacy `writeDeploymentEnvFile` call
 * site in `commands/up/up.ts`, given equivalent inputs.
 *
 * Uses the real registry writer against isolated temp project roots — the
 * point is to compare on-disk state, not mock it. Timestamps (`deployedAt`)
 * are stamped at write time and excluded from the comparison, mirroring the
 * Phase 0 `expectStateEquivalent` helper.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeploymentRecord } from '@microsoft/rayfin-tools-common/_internal/services/deployment-registry';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getActiveDeployment } from '../../utils/deployments-registry.js';
import { writeDeploymentEnvFile } from '../../utils/env-fabric-utils.js';
import { createCliDeploymentRegistryService } from '../deployment-registry.js';

/** A workspace name that needs no sanitization (keeps the writer quiet). */
const WORKSPACE_NAME = 'parity-ws';

/** The universal record the v2 `persist-deployment` step builds. */
const record: Omit<DeploymentRecord, 'deployedAt'> = {
  itemId: 'item-parity-1',
  apiUrl: 'https://api.fabric.test/workloads/item-parity-1',
  workspaceId: 'ws-parity-1',
  tenantId: 'tenant-parity-1',
  publishableKey: 'pk-parity-1',
  portalUrl: 'https://app.fabric.test',
  hostingUrl: 'https://app-parity.test',
};

/** Drop the write-time timestamp so the comparison is over durable fields. */
function stripVolatile(
  value: DeploymentRecord
): Omit<DeploymentRecord, 'deployedAt'> {
  const { deployedAt: _deployedAt, ...durable } = value;
  return durable;
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rayfin-parity-'));
  mkdirSync(join(root, 'rayfin'), { recursive: true });
  return root;
}

describe('deployment-registry state equivalence (v2 vs legacy)', () => {
  let v2Root: string;
  let legacyRoot: string;

  beforeEach(() => {
    v2Root = makeProjectRoot();
    legacyRoot = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(v2Root, { recursive: true, force: true });
    rmSync(legacyRoot, { recursive: true, force: true });
  });

  it('writes a field-equivalent registry record through both paths', async () => {
    // v2 path: the workflow's persist-deployment step delegates to the service.
    await createCliDeploymentRegistryService().persistDeployment(
      v2Root,
      WORKSPACE_NAME,
      record
    );

    // Legacy path: the `up.ts` call site mapping (record → DeploymentEnvVars).
    await writeDeploymentEnvFile(legacyRoot, WORKSPACE_NAME, {
      rayfinItemId: record.itemId,
      rayfinApiUrl: record.apiUrl,
      fabricWorkspaceId: record.workspaceId,
      fabricTenantId: record.tenantId,
      publishableKey: record.publishableKey,
      fabricPortalUrl: record.portalUrl,
      hostingUrl: record.hostingUrl,
    });

    const v2Active = getActiveDeployment(v2Root);
    const legacyActive = getActiveDeployment(legacyRoot);

    expect(v2Active).not.toBeNull();
    expect(legacyActive).not.toBeNull();
    expect(v2Active!.workspaceName).toBe(legacyActive!.workspaceName);
    expect(stripVolatile(v2Active!.record)).toEqual(
      stripVolatile(legacyActive!.record)
    );
    // And both faithfully reflect the source record.
    expect(stripVolatile(v2Active!.record)).toEqual(record);
  });
});
