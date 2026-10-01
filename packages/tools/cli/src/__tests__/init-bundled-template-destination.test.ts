import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { handleBundledTemplate } from '../commands/init-bundled-template.js';

// ── Module-level mocks ──────────────────────────────────────────────────
//
// These tests validate ONE thing: the on-disk destination `handleBundledTemplate`
// resolves for in-place vs. nest-under-name vs. named-sub-directory inputs. They
// mirror the `handleExternalTemplate` "scaffold destination" suite so both
// real handlers have symmetric destination coverage.
//
// `resolveScaffoldTarget` and `isInPlaceDirectory` run for real (importOriginal
// keeps the pure helpers); only the side-effecting boundaries — template I/O,
// the scaffold pipeline, and the filesystem write — are stubbed. The handler
// returns the resolved `targetPath`, so asserting it validates the full
// destination decision.

vi.mock('@microsoft/rayfin-tools-common/_internal/templates', async (orig) => {
  const actual =
    await orig<
      typeof import('@microsoft/rayfin-tools-common/_internal/templates')
    >();
  return {
    ...actual,
    findTemplateByName: vi.fn(() => ({
      name: 'fake-template',
      displayName: 'Fake Template',
      description: 'A fake template for unit tests',
      path: '/tmp/fake-template',
      packageJson: {},
      isLocal: false,
    })),
  };
});

vi.mock('../utils/template-scaffold.js', async (orig) => {
  const actual = await orig<typeof import('../utils/template-scaffold.js')>();
  return {
    ...actual,
    discoverBundledTemplates: vi.fn(() => [
      {
        name: 'fake-template',
        displayName: 'Fake Template',
        description: 'A fake template for unit tests',
        path: '/tmp/fake-template',
        packageJson: {},
        isLocal: false,
      },
    ]),
    copyTemplateFiles: vi.fn(),
    listBundledTemplates: vi.fn(),
    selectBundledTemplate: vi.fn(),
  };
});

// Keep resolveScaffoldTarget + isInPlaceDirectory real; stub the pipeline and
// project-name prompt so the handler resolves a deterministic destination
// without touching npm / rayfin or prompting. `resolveProjectName` returns the
// same slug the caller passes so the nest-under-name directory is predictable.
vi.mock('../utils/scaffold-pipeline.js', async (orig) => {
  const actual = await orig<typeof import('../utils/scaffold-pipeline.js')>();
  return {
    ...actual,
    runScaffoldPipeline: vi.fn(async () => undefined),
    resolveProjectName: vi.fn(async () => 'rayfin-lyra'),
    assertTargetConflictOrThrow: vi.fn(async () => ({
      consentedOverwrite: false,
      targetWasEmpty: true,
    })),
    wipeTargetDirectory: vi.fn(),
    printNextStepsBanner: vi.fn(),
    cleanupPartialScaffold: vi.fn(async () => undefined),
  };
});

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

describe('handleBundledTemplate — scaffold destination (in-place vs child directory)', () => {
  const captureMode = 'plain' as const;
  let destCwd: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    destCwd = mkdtempSync(join(tmpdir(), 'rayfin-bundled-dest-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(destCwd);

    // Silence figlet header + modeLog noise.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(destCwd, { recursive: true, force: true });
  });

  // The Fabric portal scenario: `create-rayfin . --project-name X`. Explicit
  // `.` disables nest-under-name, so files must land in cwd itself.
  it('scaffolds into cwd for explicit `.` when useProjectNameAsDirectory is false', async () => {
    const result = await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'rayfin-lyra',
      useProjectNameAsDirectory: false,
      nonInteractive: true,
      skipInstall: true,
      overwrite: true,
    });

    expect(result.targetPath).toBe(resolve(destCwd));
  });

  // The bare `npm create @microsoft/rayfin` flow: directory omitted, so the
  // gate stays on and the project nests under `<projectName>/`.
  it('nests under <projectName>/ when useProjectNameAsDirectory is true', async () => {
    const result = await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'rayfin-lyra',
      useProjectNameAsDirectory: true,
      nonInteractive: true,
      skipInstall: true,
      overwrite: true,
    });

    expect(result.targetPath).toBe(resolve(destCwd, 'rayfin-lyra'));
  });

  // An explicit named sub-directory is honored verbatim regardless of name.
  it('scaffolds into an explicitly named sub-directory', async () => {
    const result = await handleBundledTemplate('my-app', captureMode, {
      template: 'fake-template',
      projectName: 'rayfin-lyra',
      useProjectNameAsDirectory: false,
      nonInteractive: true,
      skipInstall: true,
      overwrite: true,
    });

    expect(result.targetPath).toBe(resolve(destCwd, 'my-app'));
  });
});
