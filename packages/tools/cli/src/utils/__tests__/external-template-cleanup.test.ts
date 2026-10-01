import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the template engine before importing the module under test
vi.mock('@microsoft/rayfin-tools-common/_internal/templates', () => ({
  parseManifest: vi.fn(),
  instantiateTemplate: vi.fn(),
  flattenManifestEntries: vi.fn(() => [
    { templatePath: '.', templateName: 'default', displayPath: ['default'] },
  ]),
  resolveEntryPath: vi.fn(async () => ({
    manifest: {
      apiVersion: 'v1',
      metadata: { name: 'default', displayName: 'Default' },
      entries: [{ name: 'default', path: '.' }],
    },
    sourcePath: '/tmp/cloned-repo',
  })),
  isGitUrl: vi.fn((s: string) => s.startsWith('https://')),
}));

vi.mock('@microsoft/rayfin-tools-common/_internal/templates/git', () => ({
  parseGitUrl: vi.fn((url: string) => ({ url, ref: undefined })),
  fetchTemplate: vi.fn(),
}));

// Stub the post-scaffold pipeline so cleanup tests don't shell out to
// npm/rayfin and don't trigger the interactive promptProjectName fallback.
// resolveProjectName simply returns explicit name or directory basename.
//
// IMPORTANT: this mock factory uses the `importOriginal` pattern. The
// `...actual` spread means any export NOT explicitly overridden below
// runs its REAL implementation during tests. That's required for these
// cleanup tests, which DO need real `checkTargetConflict`,
// `wipeTargetDirectory`, `cleanupPartialScaffold`, and
// `instantiateAndReport` so the test can observe real rm/rmdir effects
// on the target directory.
//
// If you add a NEW export to `scaffold-pipeline.ts` that has side effects
// you don't want exercised here (network, child_process, sleep, etc.),
// you MUST opt out by adding an explicit override below — the default
// behavior is "real implementation runs."
vi.mock('../scaffold-pipeline.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../scaffold-pipeline.js')>();
  return {
    ...actual,
    runScaffoldPipeline: vi.fn(async (_options, scaffold) => {
      await scaffold();
    }),
    resolveProjectName: vi.fn(
      async (params: {
        explicitProjectName?: string;
        directory: string;
      }): Promise<string> => {
        if (params.explicitProjectName) return params.explicitProjectName;
        const { basename } = await import('node:path');
        return basename(params.directory);
      }
    ),
  };
});

import { handleExternalTemplate } from '../../commands/init-external-template.js';
import { CliHandledError } from '../../errors.js';

describe('handleExternalTemplate cleanup', () => {
  let templates: typeof import('@microsoft/rayfin-tools-common/_internal/templates');
  let gitTemplates: typeof import('@microsoft/rayfin-tools-common/_internal/templates/git');

  let testDir: string;

  beforeEach(async () => {
    templates =
      await import('@microsoft/rayfin-tools-common/_internal/templates');
    gitTemplates =
      await import('@microsoft/rayfin-tools-common/_internal/templates/git');
    // process.exit no longer participates in handler control flow (post
    // S3-1: handlers throw CliHandledError) but stub it anyway as a
    // safety net in case any underlying utility calls it.
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    testDir = join(tmpdir(), `rayfin-cleanup-test-${randomUUID()}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should clean up a newly created target directory on scaffold failure', async () => {
    const targetDir = join(testDir, 'new-project');

    // fetchTemplate succeeds, parseManifest succeeds, instantiateTemplate throws
    vi.mocked(gitTemplates.fetchTemplate).mockResolvedValue(
      join(tmpdir(), 'fake-clone')
    );
    vi.mocked(templates.parseManifest).mockResolvedValue({
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'default', path: '.' }],
    });
    vi.mocked(templates.instantiateTemplate).mockRejectedValue(
      new Error('disk full')
    );

    // Target dir does NOT exist before — the function will mkdir it
    expect(existsSync(targetDir)).toBe(false);

    await expect(
      handleExternalTemplate(
        'https://github.com/org/template.git',
        targetDir,
        'plain',
        {}
      )
    ).rejects.toThrow(CliHandledError);

    // Target dir should have been cleaned up
    expect(existsSync(targetDir)).toBe(false);
  });

  it('should NOT delete a pre-existing target directory on scaffold failure', async () => {
    const targetDir = join(testDir, 'existing-project');

    // Create the target directory with a file BEFORE scaffolding
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'important.txt'), 'do not delete');

    vi.mocked(gitTemplates.fetchTemplate).mockResolvedValue(
      join(tmpdir(), 'fake-clone')
    );
    vi.mocked(templates.parseManifest).mockResolvedValue({
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'default', path: '.' }],
    });
    vi.mocked(templates.instantiateTemplate).mockRejectedValue(
      new Error('template error')
    );

    // Non-interactive without --overwrite: the conflict prompt cancels
    // for non-empty pre-existing targets and the handler throws
    // ScaffoldCancelledError (post-RD#1). We never reach the scaffold
    // path, so the pre-existing target is never touched.
    const { ScaffoldCancelledError } = await import('../../errors.js');
    await expect(
      handleExternalTemplate(
        'https://github.com/org/template.git',
        targetDir,
        'plain',
        { nonInteractive: true }
      )
    ).rejects.toThrow(ScaffoldCancelledError);

    // Pre-existing directory and its file should still be there
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(join(targetDir, 'important.txt'))).toBe(true);
  });

  it('should clean up an empty pre-existing target directory on scaffold failure', async () => {
    // Caruso's review of PR #1128: the empty-pre-existing-dir behavior
    // change widens cleanup ownership — `targetWasEmpty` flips the
    // cleanup gate to true, so a half-built scaffold under a
    // user-pre-created empty dir is now removed (`rm -rf`) on failure
    // instead of left as a partial mess. This test tombstones the new
    // attribution rule across all three handlers (the same widening was
    // applied to init.ts, init-bundled-template.ts, and
    // init-external-template.ts; one canonical test here is enough
    // because the gate logic is identical).
    const targetDir = join(testDir, 'empty-precreated');

    // Pre-create an EMPTY target — user-created, no content to preserve.
    mkdirSync(targetDir, { recursive: true });
    expect(existsSync(targetDir)).toBe(true);

    vi.mocked(gitTemplates.fetchTemplate).mockResolvedValue(
      join(tmpdir(), 'fake-clone')
    );
    vi.mocked(templates.parseManifest).mockResolvedValue({
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'default', path: '.' }],
    });
    vi.mocked(templates.instantiateTemplate).mockRejectedValue(
      new Error('disk full mid-scaffold')
    );

    const stderrWrites: string[] = [];
    vi.mocked(process.stderr.write).mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await expect(
      handleExternalTemplate(
        'https://github.com/org/template.git',
        targetDir,
        'plain',
        // Non-interactive without --overwrite: empty dir bypasses the
        // conflict prompt (no consent needed) and proceeds to scaffold;
        // we want to reach the failure path.
        { nonInteractive: true }
      )
    ).rejects.toThrow(CliHandledError);

    // Empty pre-existing target should be cleaned up — there was nothing
    // of the user's to preserve, so the partial scaffold is ours.
    expect(existsSync(targetDir)).toBe(false);
    // And the cleanup `modeLog` should have fired so the user knows we
    // tidied up.
    expect(stderrWrites.join('')).toContain('Cleaned up partial project');
  });

  it('should NOT delete target when scaffolding in-place', async () => {
    // Simulate in-place by using '.' as directory
    vi.mocked(gitTemplates.fetchTemplate).mockResolvedValue(
      join(tmpdir(), 'fake-clone')
    );
    vi.mocked(templates.parseManifest).mockResolvedValue({
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'default', path: '.' }],
    });
    vi.mocked(templates.instantiateTemplate).mockRejectedValue(
      new Error('render error')
    );

    const cwd = process.cwd();

    // Non-interactive bypasses the new in-place conflict prompt (B-1 fix);
    // we want the test to reach the scaffold-failure path.
    await expect(
      handleExternalTemplate(
        'https://github.com/org/template.git',
        '.',
        'plain',
        { nonInteractive: true, overwrite: true }
      )
    ).rejects.toThrow(CliHandledError);

    // CWD should still exist
    expect(existsSync(cwd)).toBe(true);
  });

  it('should exit 1 when fetchTemplate fails', async () => {
    vi.mocked(gitTemplates.fetchTemplate).mockRejectedValue(
      new Error('git clone failed')
    );

    await expect(
      handleExternalTemplate(
        'https://github.com/org/template.git',
        join(testDir, 'project'),
        'plain',
        {}
      )
    ).rejects.toThrow(CliHandledError);
  });

  it('preserves pre-existing target when --overwrite is used but clone fails afterwards', async () => {
    // Regression for the wipe-before-validate data-loss bug. The user
    // consents to overwrite via --overwrite, but if clone fails AFTER
    // consent, the wipe must NOT have happened — their data must survive.
    const targetDir = join(testDir, 'existing-with-overwrite');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'precious.txt'), 'must not be deleted');

    vi.mocked(gitTemplates.fetchTemplate).mockRejectedValue(
      new Error('git clone failed mid-fetch')
    );

    await expect(
      handleExternalTemplate(
        'https://github.com/org/template.git',
        targetDir,
        'plain',
        { nonInteractive: true, overwrite: true }
      )
    ).rejects.toThrow(CliHandledError);

    // The pre-existing data MUST survive when the new template never made
    // it past clone — the user's consent to overwrite was conditional on
    // the new source being usable.
    expect(existsSync(join(targetDir, 'precious.txt'))).toBe(true);
  });

  it('throws CliHandledError when scaffolding fails', async () => {
    // Post-S3-1: handleExternalTemplate now throws CliHandledError on
    // scaffold failure (was: process.exit(1) + return 'cancelled' sentinel).
    // The dispatcher's success-gating (persist Fabric env only on
    // 'completed') is now naturally honored — a thrown error never
    // returns 'completed', so persist never runs.
    const targetDir = join(testDir, 'returns-cancelled');

    vi.mocked(gitTemplates.fetchTemplate).mockResolvedValue(
      join(tmpdir(), 'fake-clone')
    );
    vi.mocked(templates.parseManifest).mockResolvedValue({
      apiVersion: 'v1',
      metadata: { name: 'test', displayName: 'Test' },
      entries: [{ name: 'default', path: '.' }],
    });
    vi.mocked(templates.instantiateTemplate).mockRejectedValue(
      new Error('disk full')
    );

    await expect(
      handleExternalTemplate(
        'https://github.com/org/template.git',
        targetDir,
        'plain',
        {}
      )
    ).rejects.toThrow(CliHandledError);
  });
});
