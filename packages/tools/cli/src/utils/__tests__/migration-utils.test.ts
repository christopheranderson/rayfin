import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetMigrationWarningsForTests,
  collectLegacyMigrationWarnings,
} from '../migration-utils.js';

describe('collectLegacyMigrationWarnings', () => {
  let projectRoot: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = join(
      tmpdir(),
      `rayfin-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(projectRoot, { recursive: true });
    _resetMigrationWarningsForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    _resetMigrationWarningsForTests();
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns no guidance when no legacy artifacts exist', () => {
    expect(collectLegacyMigrationWarnings(projectRoot)).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns guidance for legacy deployment files without rendering it', () => {
    writeFileSync(join(projectRoot, '.env.fabric'), 'RAYFIN_ITEM_ID=item-1\n');
    writeFileSync(
      join(projectRoot, '.env.fabric-workspace'),
      'RAYFIN_ITEM_ID=item-2\n'
    );
    writeFileSync(join(projectRoot, '.env.fabricated'), 'ignored=true\n');

    const guidance = collectLegacyMigrationWarnings(projectRoot).join('\n');

    expect(guidance).toContain('Detected env-strategy v1 artifacts');
    expect(guidance).toContain('.env.fabric, .env.fabric-workspace');
    expect(guidance).not.toContain('.env.fabricated');
    expect(guidance).toContain('rayfin/.deployments.json');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns guidance for the legacy runtime env file', () => {
    const tempEnvPath = join(projectRoot, 'rayfin', '.temp', '.env');
    mkdirSync(join(projectRoot, 'rayfin', '.temp'), { recursive: true });
    writeFileSync(tempEnvPath, 'RAYFIN_POSTGRES_PASSWORD=secret\n');

    const guidance = collectLegacyMigrationWarnings(projectRoot).join('\n');

    expect(guidance).toContain(`Legacy runtime env file: ${tempEnvPath}`);
    expect(guidance).toContain('RAYFIN_POSTGRES_PASSWORD');
    expect(guidance).toContain('rayfin/.env');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reports deployment and runtime artifacts together', () => {
    writeFileSync(
      join(projectRoot, '.env.fabric-dev'),
      'RAYFIN_ITEM_ID=item-1\n'
    );
    const tempEnvPath = join(projectRoot, 'rayfin', '.temp', '.env');
    mkdirSync(join(projectRoot, 'rayfin', '.temp'), { recursive: true });
    writeFileSync(tempEnvPath, 'PORT=3000\n');

    const guidance = collectLegacyMigrationWarnings(projectRoot).join('\n');

    expect(guidance).toContain(
      'Legacy deployment files at project root: .env.fabric-dev'
    );
    expect(guidance).toContain(`Legacy runtime env file: ${tempEnvPath}`);
  });

  it('returns guidance only once per process', () => {
    writeFileSync(join(projectRoot, '.env.fabric'), 'RAYFIN_ITEM_ID=item-1\n');

    expect(collectLegacyMigrationWarnings(projectRoot)).not.toEqual([]);
    expect(collectLegacyMigrationWarnings(projectRoot)).toEqual([]);
  });
});
