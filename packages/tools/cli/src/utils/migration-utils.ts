/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One-shot migration warnings emitted on `rayfin dev` / `rayfin up` startup
 * when env-strategy v1 artifacts are detected in the project.
 *
 * v1 → v2 transition checks (see docs/rfc/env-file-strategy.md):
 *
 * 1. `.env.fabric*` at project root  → moved into `rayfin/.deployments.json`.
 * 2. `rayfin/.temp/.env`             → merged into `rayfin/.env`.
 *
 * The `rayfin/.env` itself is handled separately (see
 * `env-file-utils.writeEnvMap`) which backs up a v1-vintage file to
 * `rayfin/.env.bak` on first v2 write so users can recover any comments
 * or curated environment-switcher blocks.
 *
 * All warnings are emitted at most once per process.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const LEGACY_ENV_FABRIC_PREFIX = '.env.fabric-';
const LEGACY_ENV_FABRIC_STATIC = '.env.fabric';

let warningsEmitted = false;

/**
 * Detect env-strategy v1 artifacts and return actionable migration guidance.
 * Idempotent: subsequent calls within the same process return no lines.
 */
export function collectLegacyMigrationWarnings(projectRoot: string): string[] {
  if (warningsEmitted) return [];
  warningsEmitted = true;

  const fabricFiles = findLegacyEnvFabricFiles(projectRoot);
  const tempEnvPath = findLegacyTempEnvFile(projectRoot);

  if (fabricFiles.length === 0 && !tempEnvPath) {
    return [];
  }

  const lines = [
    '',
    '⚠️  Detected env-strategy v1 artifacts. The Rayfin CLI no longer reads',
    '   these files; follow the steps below so your project keeps working.',
    '   See docs/rfc/env-file-strategy.md for background.',
  ];

  if (fabricFiles.length > 0) {
    lines.push(
      '',
      `   1) Legacy deployment files at project root: ${fabricFiles.join(', ')}`,
      '      → Deployment metadata now lives in rayfin/.deployments.json.',
      '      → Run `rayfin up` again for each workspace to repopulate the',
      '        registry, then delete the legacy files. The values inside are',
      '        not migrated automatically because they may be stale.'
    );
  }

  if (tempEnvPath) {
    lines.push(
      '',
      `   2) Legacy runtime env file: ${tempEnvPath}`,
      '      → Runtime values (ports, generated postgres password) now live',
      '        in rayfin/.env alongside deployment metadata.',
      '      → If you have an existing local database volume that depends on',
      '        the generated RAYFIN_POSTGRES_PASSWORD, copy that value into',
      '        rayfin/.env before the next `rayfin dev` run, otherwise the DB',
      '        connection will fail with the newly generated password.',
      '      → Otherwise: safe to delete rayfin/.temp/.env (ports will be',
      '        re-allocated automatically).'
    );
  }

  lines.push('');
  return lines;
}

/** Detect and render migration guidance for legacy command paths. */
export function warnAboutLegacyMigrations(projectRoot: string): void {
  for (const line of collectLegacyMigrationWarnings(projectRoot)) {
    console.warn(line);
  }
}

/** Reset state for tests. */
export function _resetMigrationWarningsForTests(): void {
  warningsEmitted = false;
}

function findLegacyEnvFabricFiles(projectRoot: string): string[] {
  try {
    return readdirSync(projectRoot).filter(
      (n) =>
        n === LEGACY_ENV_FABRIC_STATIC || n.startsWith(LEGACY_ENV_FABRIC_PREFIX)
    );
  } catch {
    return [];
  }
}

function findLegacyTempEnvFile(projectRoot: string): string | null {
  const candidate = join(projectRoot, 'rayfin', '.temp', '.env');
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  } catch {
    // fall through
  }
  return null;
}
