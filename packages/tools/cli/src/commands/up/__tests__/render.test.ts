import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { FabricError } from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import { HttpError } from '@microsoft/rayfin-tools-common/_internal/utils/retry';
import type { Result } from '@microsoft/rayfin-tools-common/_internal/workflows';
import type {
  UpNotice,
  UpResult,
} from '@microsoft/rayfin-tools-common/_internal/workflows/up';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliHandledError } from '../../../errors.js';
import {
  failUpWithWarnings,
  mergeWarnings,
  renderUpDryRun,
  renderUpResult,
} from '../render.js';

const BACKUP_NOTICE: UpNotice = {
  kind: 'env-backup',
  sourcePath: '/proj/rayfin/.env',
  backupPath: '/proj/rayfin/.env.bak',
};

describe('up result rendering', () => {
  let stderrWrites: string[];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('de-duplicates warnings by value while preserving first-seen order', () => {
    expect(
      mergeWarnings(
        ['first warning', 'shared warning'],
        ['shared warning', 'last warning', 'first warning']
      )
    ).toEqual(['first warning', 'shared warning', 'last warning']);
  });

  it('renders notices and only new warnings once when cancelled in plain mode', () => {
    const result: Result<UpResult, UpNotice> = {
      status: 'cancelled',
      notices: [BACKUP_NOTICE],
      warnings: ['already rendered', 'workflow warning', 'workflow warning'],
    };

    renderUpResult(result, 'project', 'plain', ['already rendered']);

    expect(stderrWrites).toEqual([
      expect.stringContaining('Backed up your previous /proj/rayfin/.env'),
      expect.stringContaining(
        'Variable values are preserved; comments and ordering are not.'
      ),
      expect.stringContaining('Deployment cancelled'),
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('⚠️  workflow warning');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('renders notices and only new warnings once when failed in plain mode', () => {
    const cause = new HttpError('deployment stopped', 500);
    const result: Result<UpResult, UpNotice> = {
      status: 'failed',
      error: { code: 'E_DEPLOY', message: 'deployment stopped', cause },
      notices: [BACKUP_NOTICE],
      warnings: ['already rendered', 'workflow warning', 'workflow warning'],
    };

    try {
      renderUpResult(result, 'project', 'plain', ['already rendered']);
      expect.fail('Expected renderUpResult to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliHandledError);
      expect((error as CliHandledError).originalError).toBe(cause);
      expect(
        (error as CliHandledError).originalError as HttpError
      ).toHaveProperty('statusCode', 500);
    }

    expect(stderrWrites).toEqual([
      expect.stringContaining('Backed up your previous /proj/rayfin/.env'),
      expect.stringContaining(
        'Variable values are preserved; comments and ordering are not.'
      ),
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('⚠️  workflow warning');
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      '\n❌ Deployment failed: deployment stopped'
    );
  });

  it('renders actionable guidance when Fabric capacity is exhausted', () => {
    const cause = new FabricError(
      'Create item failed: 429',
      429,
      'CapacityLimitExceeded'
    );
    const result: Result<UpResult, UpNotice> = {
      status: 'failed',
      error: {
        code: 'fabric-capacity-exhausted',
        message: cause.message,
        cause,
      },
    };

    expect(() => renderUpResult(result, 'project', 'plain')).toThrow(
      CliHandledError
    );

    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      '\n❌ Deployment failed: The Fabric capacity assigned to this workspace is exhausted and cannot create another Rayfin item.'
    );
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      '   You must pass a valid workspace ID with `--workspace-id <id>` or a valid capacity ID with `--capacity-id <id>` to complete deployment.'
    );
  });

  it('serializes exhausted-capacity guidance as one JSON error', () => {
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const cause = new FabricError(
      'Create item failed: 429',
      429,
      'CapacityLimitExceeded'
    );
    const result: Result<UpResult, UpNotice> = {
      status: 'failed',
      error: {
        code: 'fabric-capacity-exhausted',
        message: cause.message,
        cause,
      },
    };

    expect(() => renderUpResult(result, 'project', 'json')).toThrow(
      CliHandledError
    );

    expect(stdoutWrites).toHaveLength(1);
    expect(JSON.parse(stdoutWrites[0])).toMatchObject({
      status: 'error',
      error:
        'The Fabric capacity assigned to this workspace is exhausted and cannot create another Rayfin item.',
      code: 'fabric-capacity-exhausted',
      hint: 'You must pass a valid workspace ID with `--workspace-id <id>` or a valid capacity ID with `--capacity-id <id>` to complete deployment.',
    });
  });

  it('de-duplicates pre-flight warnings before rendering and failing', () => {
    expect(() =>
      failUpWithWarnings('plain', 'workspace targeting failed', [
        'registry warning',
        'registry warning',
      ])
    ).toThrow(CliHandledError);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith('⚠️  registry warning');
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith('❌ workspace targeting failed');
  });
});

describe('up dry-run rendering', () => {
  const config = {
    id: 'my-app',
    services: {
      auth: { enabled: true },
      data: { enabled: false },
      staticHosting: { enabled: true },
    },
  } as unknown as RayfinConfig;

  const packageVersions = {
    '@microsoft/rayfin-auth': '1.35.2',
    '@microsoft/rayfin-cli': '1.36.0',
  };

  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the versions it would declare in plain mode', () => {
    renderUpDryRun(config, 'my-app', false, false, false, 'plain', [], {
      ...packageVersions,
    });

    const output = stderrWrites.join('');
    expect(output).toContain('Declare package versions');
    expect(output).toContain('@microsoft/rayfin-cli 1.36.0');
    expect(output).toContain('@microsoft/rayfin-auth 1.35.2');
  });

  it('carries the versions in the single JSON plan object', () => {
    const preflight = [
      { text: 'Write services.staticHosting.assetAccess', blocking: false },
    ];
    renderUpDryRun(
      config,
      'my-app',
      false,
      false,
      false,
      'json',
      [],
      { ...packageVersions },
      preflight
    );

    expect(stdoutWrites).toHaveLength(1);
    const plan = JSON.parse(stdoutWrites[0]);
    expect(plan.status).toBe('dry-run');
    expect(plan.blocked).toBe(false);
    expect(plan.plan.packageVersions).toEqual(packageVersions);
    expect(plan.plan.preflight).toEqual(preflight);
    expect(stderrWrites).toEqual([]);
  });

  it('describes an explicit capacity in the JSON dry-run plan', () => {
    renderUpDryRun(
      config,
      'my-app',
      false,
      false,
      false,
      'json',
      [],
      {},
      [],
      undefined,
      undefined,
      false,
      'fallback',
      {
        capacityId: '11111111-1111-4111-8111-111111111111',
        assignmentMode: 'automatic',
      }
    );

    expect(
      JSON.parse(stdoutWrites[0]).plan.targeting.fabricReadiness
    ).toMatchObject({
      capacitySelection: 'explicit',
      capacityId: '11111111-1111-4111-8111-111111111111',
      assignmentConsent: 'explicit-capacity',
      startTrialIfNeeded: false,
    });
  });

  it('describes automatic capacity consent in the JSON dry-run plan', () => {
    renderUpDryRun(
      config,
      'my-app',
      false,
      false,
      false,
      'json',
      [],
      {},
      [],
      undefined,
      undefined,
      false,
      'fallback',
      { assignmentMode: 'automatic' }
    );

    expect(
      JSON.parse(stdoutWrites[0]).plan.targeting.fabricReadiness
    ).toMatchObject({
      assignmentConsent: 'automatic',
      ambiguousCapacitySelection: 'capacity-id-required',
      startTrialIfNeeded: true,
    });
  });

  it('skips capacity readiness for a recorded deployment', () => {
    renderUpDryRun(
      config,
      'my-app',
      false,
      false,
      false,
      'json',
      ['Ignoring --capacity-id for the recorded deployment.'],
      {},
      [],
      undefined,
      { id: 'workspace-1', displayName: 'Workspace' },
      true,
      'fallback',
      {
        capacityId: '11111111-1111-4111-8111-111111111111',
        assignmentMode: 'automatic',
      },
      true
    );

    const result = JSON.parse(stdoutWrites[0]);
    expect(result.plan.targeting.fabricReadiness).toEqual({
      target: 'recorded-deployment',
      checkCapacity: false,
      capacitySelection: 'skipped',
      startTrialIfNeeded: false,
      createWorkspaceIfNeeded: false,
      assignCapacityIfNeeded: false,
    });
    expect(result.plan.targeting.fabricReadiness).not.toHaveProperty(
      'capacityId'
    );
  });

  it('qualifies automatic capacity consent in a plain dry run', () => {
    renderUpDryRun(
      config,
      'my-app',
      false,
      false,
      false,
      'plain',
      [],
      {},
      [],
      undefined,
      undefined,
      false,
      'fallback',
      { assignmentMode: 'automatic' }
    );

    expect(stderrWrites.join('')).toContain(
      'Assign capacity automatically when selection is deterministic; require --capacity-id when multiple capacities are available'
    );
  });

  it('reports required capacity confirmation in a plain dry run', () => {
    renderUpDryRun(
      config,
      'my-app',
      false,
      false,
      false,
      'plain',
      [],
      {},
      [],
      undefined,
      undefined,
      false,
      'fallback',
      { assignmentMode: 'confirm' }
    );

    expect(stderrWrites.join('')).toContain(
      'Require confirmation before assigning the selected or trial capacity'
    );
  });

  it('lists the pre-flight before the operations it gates', () => {
    renderUpDryRun(config, 'my-app', false, false, false, 'plain', [], {}, [
      { text: 'Prompt for the access posture', blocking: false },
    ]);

    const output = stderrWrites.join('');
    expect(output).toContain('✓ Prompt for the access posture');
    expect(output.indexOf('Prompt for the access posture')).toBeLessThan(
      output.indexOf('Create or reuse Rayfin item')
    );
  });

  it('marks a blocking entry and fails the dry run', () => {
    expect(() =>
      renderUpDryRun(config, 'my-app', false, false, false, 'plain', [], {}, [
        { text: 'assetAccess is not protected or public', blocking: true },
      ])
    ).toThrow(/blocking problem/);

    const output = stderrWrites.join('');
    expect(output).toContain('❌ assetAccess is not protected or public');
    expect(output).not.toContain('✓ assetAccess is not protected or public');
  });

  it('fails the JSON dry run when an entry is blocking', () => {
    expect(() =>
      renderUpDryRun(config, 'my-app', false, false, false, 'json', [], {}, [
        { text: 'assetAccess is not protected or public', blocking: true },
      ])
    ).toThrow(/blocking problem/);

    expect(JSON.parse(stdoutWrites[0]).blocked).toBe(true);
  });

  it('omits the section when no version could be resolved', () => {
    renderUpDryRun(config, 'my-app', false, false, false, 'plain', [], {});

    expect(stderrWrites.join('')).not.toContain('Declare package versions');
  });
});
