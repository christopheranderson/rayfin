import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { handleBundledTemplate } from '../commands/init-bundled-template.js';
import { runScaffoldPipeline } from '../utils/scaffold-pipeline.js';

// ── Module-level mocks ──────────────────────────────────────────────────
//
// `handleBundledTemplate` does a lot — figlet header, template discovery,
// project-name prompts, target-dir conflict detection, scaffold pipeline.
// These tests only care about ONE thing: whether the dialect prompt is
// presented. So we stub out everything around it and spy on
// `inquirer.default.prompt` to record question names.

// Templates shared utilities: keep `transformProjectName` (pure), stub the
// rest so we can pretend a `bundled-template` exists without touching disk.
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

// Stub feature flags so we can control whether postgresql is enabled.
// Default: postgresql disabled (only mssql available).
//
// Declared through `vi.hoisted` because `vi.mock` is hoisted above the module
// imports: the factory runs as soon as any module in the graph imports
// feature-flags, which is before a plain top-level const would be initialized.
const { mockFeatureFlagGet } = vi.hoisted(() => ({
  mockFeatureFlagGet: vi.fn((_name: string) => false),
}));
vi.mock('../utils/feature-flags.js', () => ({
  createCliFeatureFlags: vi.fn(() => ({
    get: mockFeatureFlagGet,
    register: vi.fn(),
  })),
}));

// Stub the bundled-template I/O surface: discovery, file-copy, picker.
// We always return ONE template so `--template` lookup succeeds and the
// flow proceeds into the dialect-decision block.
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

// Stub the post-scaffold pipeline so unit tests don't shell out to npm /
// rayfin and so we never touch the filesystem. `importOriginal` keeps
// pure helpers (slugifyDirectoryArg, isInPlaceDirectory, etc.) real;
// only the side-effecting boundaries are overridden.
vi.mock('../utils/scaffold-pipeline.js', async (orig) => {
  const actual = await orig<typeof import('../utils/scaffold-pipeline.js')>();
  return {
    ...actual,
    runScaffoldPipeline: vi.fn(async () => undefined),
    resolveProjectName: vi.fn(async () => 'Fake Project'),
    assertTargetConflictOrThrow: vi.fn(async () => ({
      consentedOverwrite: false,
      targetWasEmpty: true,
    })),
    wipeTargetDirectory: vi.fn(),
    printNextStepsBanner: vi.fn(),
    cleanupPartialScaffold: vi.fn(async () => undefined),
  };
});

// Skip the real mkdirSync side-effect (we already short-circuit the
// pipeline above; no need to touch the filesystem).
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

describe('handleBundledTemplate dialect prompt suppression', () => {
  // PromptModule signature doesn't fit MockInstance's generic shape; matches
  // the `let promptSpy: any` pattern used in init.test.ts for the same reason.
  let promptSpy: any;
  let askedQuestionNames: string[];
  const captureMode = 'plain' as const;

  beforeEach(async () => {
    askedQuestionNames = [];

    // Default: postgresql feature flag disabled
    mockFeatureFlagGet.mockImplementation((_name: string) => false);

    const inquirerModule = await import('inquirer');
    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation((async (questions: unknown) => {
        const list = Array.isArray(questions) ? questions : [questions];
        for (const q of list as Array<{ name: string }>) {
          askedQuestionNames.push(q.name);
        }
        // Default answers for any prompt the bundled flow happens to ask
        // (project-name fallback, dialect, overwrite). The dialect-prompt
        // tests assert prompt-name presence, not the returned value.
        const answers: Record<string, unknown> = {};
        for (const q of list as Array<{ name: string }>) {
          if (q.name === 'dialect') answers.dialect = 'mssql';
          if (q.name === 'projectName') answers.projectName = 'Fake Project';
          if (q.name === 'overwrite') answers.overwrite = true;
        }
        return answers;
      }) as never);

    // Silence stdout/stderr noise from figlet header + modeLog.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // Each entry is one of the Fabric-targeting flags that must short-circuit
  // the dialect prompt and default to MSSQL (Fabric is MSSQL-only today).
  const fabricFlagCases: Array<{
    label: string;
    options: Parameters<typeof handleBundledTemplate>[2];
  }> = [
    { label: '--workspace', options: { workspace: 'My Workspace' } },
    {
      label: '--workspace-id',
      options: { workspaceId: '00000000-0000-0000-0000-000000000000' },
    },
    {
      label: '--item-id',
      options: { itemId: '11111111-1111-1111-1111-111111111111' },
    },
    {
      label: '--base-api-url',
      options: { baseApiUrl: 'https://api.fabric.microsoft.com' },
    },
  ];

  it.each(fabricFlagCases)(
    'does not present the dialect prompt when $label is provided',
    async ({ options }) => {
      await handleBundledTemplate('.', captureMode, {
        template: 'fake-template',
        projectName: 'Fake Project',
        skipInstall: true,
        ...options,
      });

      expect(askedQuestionNames).not.toContain('dialect');
    }
  );

  it('does not present the dialect prompt when --dialect is provided', async () => {
    await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'Fake Project',
      dialect: 'postgresql',
      skipInstall: true,
    });

    expect(askedQuestionNames).not.toContain('dialect');
  });

  it('does not present the dialect prompt in --non-interactive mode', async () => {
    await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'Fake Project',
      nonInteractive: true,
      skipInstall: true,
    });

    expect(askedQuestionNames).not.toContain('dialect');
  });

  it('presents the dialect prompt when postgresql flag is active and no other skip flags provided', async () => {
    mockFeatureFlagGet.mockImplementation(
      (name: string) => name === 'postgresql'
    );

    await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'Fake Project',
      skipInstall: true,
    });

    expect(askedQuestionNames).toContain('dialect');
  });

  it('preserves the authored package versions bundled templates ship with', async () => {
    // Bundled templates declare their own `@microsoft/rayfin-*` ranges. Letting
    // the from-template sync reinstall them repins the scaffolded root to the
    // CLI's exact version while nested workspace manifests keep the authored
    // range, and a capability pack that pins `match:@microsoft/rayfin-core`
    // then refuses to apply against the two disagreeing declarations.
    await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'Fake Project',
      skipInstall: true,
    });

    const [pipelineOptions] = vi.mocked(runScaffoldPipeline).mock.calls[0];
    expect(pipelineOptions.preserveTemplatePackageVersions).toBe(true);
  });

  it('skips the dialect prompt when postgresql flag is inactive (only mssql available)', async () => {
    mockFeatureFlagGet.mockImplementation((_name: string) => false);

    await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'Fake Project',
      skipInstall: true,
    });

    expect(askedQuestionNames).not.toContain('dialect');

    const pipeline = await import('../utils/scaffold-pipeline.js');
    const [pipelineOptions] = vi.mocked(pipeline.runScaffoldPipeline).mock
      .calls[0];
    expect(pipelineOptions.dialect).toBe('mssql');
  });

  it('skips the dialect step when the template ships data disabled, even with postgresql active', async () => {
    // postgresql on ⇒ a two-choice dialect prompt would normally appear.
    mockFeatureFlagGet.mockImplementation(
      (name: string) => name === 'postgresql'
    );

    // Fixture template whose authored rayfin.yml disables the data service.
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const fixtureDir = pathJoin(tmpdir(), `blankish-${Date.now()}`);
    realFs.mkdirSync(pathJoin(fixtureDir, 'rayfin'), { recursive: true });
    realFs.writeFileSync(
      pathJoin(fixtureDir, 'rayfin', 'rayfin.yml'),
      'services:\n  data:\n    enabled: false\n    dialect: mssql\n',
      'utf8'
    );

    const { findTemplateByName } =
      await import('@microsoft/rayfin-tools-common/_internal/templates');
    vi.mocked(findTemplateByName).mockReturnValueOnce({
      name: 'blankish',
      displayName: 'Blankish',
      description: 'data-disabled fixture',
      path: fixtureDir,
      packageJson: {},
      isLocal: false,
    });

    try {
      await handleBundledTemplate('.', captureMode, {
        template: 'blankish',
        projectName: 'Fake Project',
        skipInstall: true,
      });

      expect(askedQuestionNames).not.toContain('dialect');
      const [pipelineOptions] = vi.mocked(runScaffoldPipeline).mock.calls[0];
      expect(pipelineOptions.dialect).toBeUndefined();
    } finally {
      realFs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('presents the dialect prompt when the template disables data but --services data is passed (postgresql active)', async () => {
    // postgresql on ⇒ a two-choice dialect prompt is available.
    mockFeatureFlagGet.mockImplementation(
      (name: string) => name === 'postgresql'
    );

    // Fixture template ships data disabled, but the user opts in via
    // `--services data`, so the scaffold pipeline will enable the data block.
    // The dialect must still be chosen — skipping it would silently fall back
    // to MSSQL and rob the user of the PostgreSQL choice.
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const fixtureDir = pathJoin(tmpdir(), `blankish-svc-${Date.now()}`);
    realFs.mkdirSync(pathJoin(fixtureDir, 'rayfin'), { recursive: true });
    realFs.writeFileSync(
      pathJoin(fixtureDir, 'rayfin', 'rayfin.yml'),
      'services:\n  data:\n    enabled: false\n',
      'utf8'
    );

    const { findTemplateByName } =
      await import('@microsoft/rayfin-tools-common/_internal/templates');
    vi.mocked(findTemplateByName).mockReturnValueOnce({
      name: 'blankish',
      displayName: 'Blankish',
      description: 'data-disabled fixture',
      path: fixtureDir,
      packageJson: {},
      isLocal: false,
    });

    try {
      await handleBundledTemplate('.', captureMode, {
        template: 'blankish',
        projectName: 'Fake Project',
        services: 'data',
        skipInstall: true,
      });

      expect(askedQuestionNames).toContain('dialect');
      const [pipelineOptions] = vi.mocked(runScaffoldPipeline).mock.calls[0];
      expect(pipelineOptions.dialect).toBeDefined();
    } finally {
      realFs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('forwards the chosen dialect to the scaffold pipeline (Fabric flags ⇒ mssql)', async () => {
    await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'Fake Project',
      workspaceId: '00000000-0000-0000-0000-000000000000',
      skipInstall: true,
    });

    expect(runScaffoldPipeline).toHaveBeenCalledTimes(1);
    const [pipelineOptions] = vi.mocked(runScaffoldPipeline).mock.calls[0];
    expect(pipelineOptions.dialect).toBe('mssql');
  });

  it('forwards an explicit --dialect through unchanged', async () => {
    await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'Fake Project',
      dialect: 'postgresql',
      skipInstall: true,
    });

    const [pipelineOptions] = vi.mocked(runScaffoldPipeline).mock.calls[0];
    expect(pipelineOptions.dialect).toBe('postgresql');
  });

  // Ensure we didn't accidentally call inquirer.prompt for any reason
  // when every interactive boundary should be short-circuited by flags.
  it('makes zero inquirer.prompt calls when all flags are provided', async () => {
    await handleBundledTemplate('.', captureMode, {
      template: 'fake-template',
      projectName: 'Fake Project',
      dialect: 'mssql',
      nonInteractive: true,
      skipInstall: true,
    });

    expect(promptSpy).not.toHaveBeenCalled();
  });
});
