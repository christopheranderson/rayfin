import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { init } from '../commands/init';
import { CliHandledError } from '../errors';

// Mock the template engine modules
vi.mock('@microsoft/rayfin-tools-common/_internal/templates', () => ({
  parseManifest: vi.fn(),
  instantiateTemplate: vi.fn(() => ({
    createdFiles: ['file1.ts'],
    skippedFiles: [],
    parameters: {},
    targetDir: '/tmp/target',
  })),
  flattenManifestEntries: vi.fn(),
  hasGroups: vi.fn(),
  resolveEntryPath: vi.fn(),
  isGitUrl: vi.fn((input: string) => input.startsWith('https://')),
}));

vi.mock('@microsoft/rayfin-tools-common/_internal/templates/git', () => ({
  parseGitUrl: vi.fn((url: string) => ({ url, ref: undefined })),
  fetchTemplate: vi.fn(() => '/tmp/cloned-repo'),
}));

// Stub out the post-scaffold pipeline so unit tests don't actually shell
// out to npm/rayfin. Tests in this file focus on manifest selection and
// dispatch logic; the pipeline has its own e2e coverage.
//
// IMPORTANT: this mock factory uses the `importOriginal` pattern. The
// `...actual` spread means any export NOT explicitly overridden below
// runs its REAL implementation during tests. That's intentional — pure
// helpers like `slugifyDirectoryArg`, `isInPlaceDirectory`,
// `formatCdTarget`, `printNextStepsBanner`, `wipeTargetDirectory`,
// `checkTargetConflict`, `cleanupPartialScaffold`, and
// `instantiateAndReport` are safe to run in unit tests because they're
// either pure or delegate to already-mocked boundaries (e.g.,
// `instantiateTemplate` is mocked at the templates module).
//
// If you add a NEW export to `scaffold-pipeline.ts` that has side effects
// you don't want exercised in this test (network, child_process, sleep,
// etc.), you MUST opt out by adding an explicit override below — the
// default behavior is "real implementation runs."
vi.mock('../utils/scaffold-pipeline.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/scaffold-pipeline.js')>();
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
        // Mirror real behavior: explicit wins; otherwise return basename
        // (NOT the full path). Returning the full path would mask any test
        // that exercises the fallback by silently producing garbage.
        if (params.explicitProjectName) return params.explicitProjectName;
        const { basename } = await import('node:path');
        return basename(params.directory);
      }
    ),
  };
});

vi.mock('../utils/catalog-navigator.js', () => ({
  navigateCatalog: vi.fn(),
}));

describe('init --template-name option', () => {
  let initCommand: Command;

  beforeEach(() => {
    initCommand = init();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should have --template-name option', () => {
    const opts = initCommand.options.map((o) => o.long);
    expect(opts).toContain('--template-name');
  });

  it('should describe --template-name for multi-template selection', () => {
    const opt = initCommand.options.find((o) => o.long === '--template-name');
    expect(opt).toBeDefined();
    expect(opt!.description).toMatch(/multi-template/i);
  });

  it('should have -l as short alias for --list-templates', () => {
    const opt = initCommand.options.find((o) => o.long === '--list-templates');
    expect(opt).toBeDefined();
    expect(opt!.short).toBe('-l');
  });
});

describe('handleExternalTemplate', () => {
  let templates: typeof import('@microsoft/rayfin-tools-common/_internal/templates');
  let handleExternalTemplate: (typeof import('../commands/init-external-template'))['handleExternalTemplate'];

  let exitSpy: any;
  let logOutput: string[];
  let errorOutput: string[];
  let warnOutput: string[];

  const captureMode = 'plain' as const;

  beforeEach(async () => {
    templates =
      await import('@microsoft/rayfin-tools-common/_internal/templates');
    const mod = await import('../commands/init-external-template');
    handleExternalTemplate = mod.handleExternalTemplate;

    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    logOutput = [];
    errorOutput = [];
    warnOutput = [];

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logOutput.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorOutput.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnOutput.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSingleEntryManifest() {
    vi.mocked(templates.parseManifest).mockResolvedValue({
      apiVersion: 'v1',
      metadata: { name: 'single', displayName: 'Single Template' },
      entries: [{ name: 'only-one', path: '.' }],
    });
    vi.mocked(templates.flattenManifestEntries).mockReturnValue([
      {
        templatePath: '.',
        templateName: 'only-one',
        displayPath: ['only-one'],
      },
    ]);
    vi.mocked(templates.hasGroups).mockReturnValue(false);
    vi.mocked(templates.resolveEntryPath).mockResolvedValue({
      manifest: {
        apiVersion: 'v1',
        metadata: { name: 'only-one', displayName: 'Only One' },
        entries: [{ name: 'only-one', path: '.' }],
      },
      sourcePath: '/tmp/cloned-repo',
    });
  }

  function mockMultiEntryManifest() {
    vi.mocked(templates.parseManifest).mockResolvedValue({
      apiVersion: 'v1',
      metadata: { name: 'multi', displayName: 'Multi Templates' },
      entries: [
        { name: 'starter', path: 'templates/starter' },
        { name: 'advanced', path: 'templates/advanced' },
      ],
    });
    vi.mocked(templates.flattenManifestEntries).mockReturnValue([
      {
        templatePath: 'templates/starter',
        templateName: 'starter',
        displayPath: ['starter'],
      },
      {
        templatePath: 'templates/advanced',
        templateName: 'advanced',
        displayPath: ['advanced'],
      },
    ]);
    vi.mocked(templates.hasGroups).mockReturnValue(false);
    vi.mocked(templates.resolveEntryPath).mockResolvedValue({
      manifest: {
        apiVersion: 'v1',
        metadata: { name: 'starter', displayName: 'Starter' },
        entries: [{ name: 'starter', path: '.' }],
      },
      sourcePath: '/tmp/cloned-repo/templates/starter',
    });
  }

  describe('single-entry manifests', () => {
    it('auto-selects the only template', async () => {
      mockSingleEntryManifest();

      await handleExternalTemplate(
        'https://github.com/org/template',
        '/tmp/test',
        captureMode,
        { nonInteractive: true }
      );

      expect(templates.resolveEntryPath).toHaveBeenCalledWith(
        '/tmp/cloned-repo',
        '.'
      );
      expect(templates.instantiateTemplate).toHaveBeenCalled();
    });

    it('accepts --template-name that matches the single entry', async () => {
      mockSingleEntryManifest();

      await handleExternalTemplate(
        'https://github.com/org/template',
        '/tmp/test',
        captureMode,
        { templateName: 'only-one', nonInteractive: true }
      );

      expect(templates.resolveEntryPath).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('errors when --template-name does not match single entry', async () => {
      mockSingleEntryManifest();

      await expect(
        handleExternalTemplate(
          'https://github.com/org/template',
          '/tmp/test',
          captureMode,
          { templateName: 'wrong-name', nonInteractive: true }
        )
      ).rejects.toThrow(CliHandledError);
      const allOutput = [...errorOutput].join('\n');
      expect(allOutput).toContain('not found');
    });
  });

  describe('multi-entry manifests', () => {
    it('selects template by name', async () => {
      mockMultiEntryManifest();

      await handleExternalTemplate(
        'https://github.com/org/templates',
        '/tmp/test',
        captureMode,
        { templateName: 'starter', nonInteractive: true }
      );

      expect(templates.resolveEntryPath).toHaveBeenCalledWith(
        '/tmp/cloned-repo',
        'templates/starter'
      );
    });

    it('falls back to path matching with warning', async () => {
      mockMultiEntryManifest();
      // Override: name won't match, but path will
      vi.mocked(templates.flattenManifestEntries).mockReturnValue([
        {
          templatePath: 'templates/starter',
          displayPath: ['templates/starter'],
        },
        {
          templatePath: 'templates/advanced',
          displayPath: ['templates/advanced'],
        },
      ]);

      await handleExternalTemplate(
        'https://github.com/org/templates',
        '/tmp/test',
        captureMode,
        { templateName: 'templates/starter', nonInteractive: true }
      );

      const allOutput = [...logOutput, ...warnOutput].join('\n');
      expect(allOutput).toContain('matched by path instead');
    });

    it('errors when template name not found', async () => {
      mockMultiEntryManifest();

      await expect(
        handleExternalTemplate(
          'https://github.com/org/templates',
          '/tmp/test',
          captureMode,
          { templateName: 'nonexistent', nonInteractive: true }
        )
      ).rejects.toThrow(CliHandledError);
      const allOutput = [...errorOutput].join('\n');
      expect(allOutput).toContain('not found');
      expect(allOutput).toContain('not found. Available');
    });

    it('errors when non-interactive without --template-name on multi-entry', async () => {
      mockMultiEntryManifest();

      await expect(
        handleExternalTemplate(
          'https://github.com/org/templates',
          '/tmp/test',
          captureMode,
          { nonInteractive: true }
        )
      ).rejects.toThrow(CliHandledError);
      const allOutput = [...errorOutput].join('\n');
      expect(allOutput).toContain('multiple entries');
      expect(allOutput).toContain('--template-name');
    });

    it('includes templatePath in ambiguity error for disambiguation', async () => {
      mockMultiEntryManifest();
      // Both entries share the same name
      vi.mocked(templates.flattenManifestEntries).mockReturnValue([
        {
          templatePath: 'web/starter',
          templateName: 'starter',
          displayPath: ['Web', 'starter'],
        },
        {
          templatePath: 'mobile/starter',
          templateName: 'starter',
          displayPath: ['Mobile', 'starter'],
        },
      ]);

      await expect(
        handleExternalTemplate(
          'https://github.com/org/templates',
          '/tmp/test',
          captureMode,
          { templateName: 'starter', nonInteractive: true }
        )
      ).rejects.toThrow(CliHandledError);
      const allOutput = [...errorOutput].join('\n');
      expect(allOutput).toContain('ambiguous');
      expect(allOutput).toContain('web/starter');
      expect(allOutput).toContain('mobile/starter');
    });
  });

  describe('failure cleanup', () => {
    it('cleans up cloned temp directory on error', async () => {
      vi.mocked(templates.parseManifest).mockRejectedValue(
        new Error('parse failed')
      );

      await expect(
        handleExternalTemplate(
          'https://github.com/org/template',
          '/tmp/test',
          captureMode,
          {}
        )
      ).rejects.toThrow(CliHandledError);
    });
  });

  // Behavior-level destination validation. The dispatcher-gating tests prove
  // the `useProjectNameAsDirectory` gate reaches this handler; these prove the
  // handler then resolves the project to the right place on disk.
  // resolveScaffoldTarget runs for real here (only runScaffoldPipeline /
  // instantiateTemplate are stubbed), and the handler returns the resolved
  // targetPath, so asserting it validates the full destination decision.
  describe('scaffold destination (in-place vs child directory)', () => {
    let destCwd: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      destCwd = mkdtempSync(join(tmpdir(), 'rayfin-dest-'));
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(destCwd);
      mockSingleEntryManifest();
    });

    afterEach(() => {
      cwdSpy.mockRestore();
      rmSync(destCwd, { recursive: true, force: true });
    });

    // The Fabric portal scenario: `create-rayfin . --project-name X`. Explicit
    // `.` disables nest-under-name, so files must land in cwd itself.
    it('scaffolds into cwd for explicit `.` when useProjectNameAsDirectory is false', async () => {
      const result = await handleExternalTemplate(
        'https://github.com/org/template',
        '.',
        captureMode,
        {
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: false,
          nonInteractive: true,
          overwrite: true,
        }
      );

      expect(result.targetPath).toBe(resolve(destCwd));
      expect(templates.instantiateTemplate).toHaveBeenCalled();
    });

    // The bare `npm create @microsoft/rayfin` flow: directory omitted, so the
    // gate stays on and the project nests under `<projectName>/`.
    it('nests under <projectName>/ when useProjectNameAsDirectory is true', async () => {
      const result = await handleExternalTemplate(
        'https://github.com/org/template',
        '.',
        captureMode,
        {
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: true,
          nonInteractive: true,
          overwrite: true,
        }
      );

      expect(result.targetPath).toBe(resolve(destCwd, 'rayfin-lyra'));
    });

    // An explicit named sub-directory is honored verbatim regardless of name.
    it('scaffolds into an explicitly named sub-directory', async () => {
      const result = await handleExternalTemplate(
        'https://github.com/org/template',
        'my-app',
        captureMode,
        {
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: false,
          nonInteractive: true,
          overwrite: true,
        }
      );

      expect(result.targetPath).toBe(resolve(destCwd, 'my-app'));
    });
  });
});

describe('handleExternalTemplate — registry ref and path', () => {
  let templates: typeof import('@microsoft/rayfin-tools-common/_internal/templates');
  let gitTemplates: typeof import('@microsoft/rayfin-tools-common/_internal/templates/git');
  let handleExternalTemplate: (typeof import('../commands/init-external-template'))['handleExternalTemplate'];

  beforeEach(async () => {
    vi.resetModules();
    templates =
      await import('@microsoft/rayfin-tools-common/_internal/templates');
    gitTemplates =
      await import('@microsoft/rayfin-tools-common/_internal/templates/git');
    const mod = await import('../commands/init-external-template');
    handleExternalTemplate = mod.handleExternalTemplate;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads registry ref into the clone URL via #ref suffix', async () => {
    vi.mocked(gitTemplates.parseGitUrl).mockImplementation((url: string) => {
      const [base, ref] = url.split('#');
      return { url: base, ref };
    });
    vi.mocked(templates.parseManifest).mockResolvedValue({
      apiVersion: 'v1',
      metadata: { name: 't', displayName: 'T' },
      entries: [{ name: 't', path: '.' }],
    });
    vi.mocked(templates.flattenManifestEntries).mockReturnValue([
      { templatePath: '.', templateName: 't', displayPath: ['t'] },
    ]);
    vi.mocked(templates.resolveEntryPath).mockResolvedValue({
      manifest: {
        apiVersion: 'v1',
        metadata: { name: 't', displayName: 'T' },
        entries: [{ name: 't', path: '.' }],
      },
      sourcePath: '/tmp/cloned-repo',
    });

    await handleExternalTemplate(
      'https://github.com/org/repo.git#v1.2.0',
      '/tmp/test',
      'plain',
      { nonInteractive: true }
    );

    // parseGitUrl should have received the #ref suffixed URL and split it
    expect(gitTemplates.parseGitUrl).toHaveBeenCalledWith(
      'https://github.com/org/repo.git#v1.2.0'
    );
    // fetchTemplate should have been called with the parsed source containing ref
    expect(gitTemplates.fetchTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'v1.2.0' }),
      expect.objectContaining({ onArchiveFallback: expect.any(Function) })
    );
  });

  it('uses registryPath to scope the manifest root', async () => {
    vi.mocked(gitTemplates.parseGitUrl).mockImplementation((url: string) => ({
      url,
      ref: undefined,
    }));
    vi.mocked(gitTemplates.fetchTemplate).mockResolvedValue('/tmp/cloned-repo');
    // First resolveEntryPath call is for the registry path
    vi.mocked(templates.resolveEntryPath)
      .mockResolvedValueOnce({
        manifest: {
          apiVersion: 'v1',
          metadata: { name: 'official', displayName: 'Official' },
          entries: [{ name: 'starter', path: '.' }],
        },
        sourcePath: '/tmp/cloned-repo/catalogs/official',
      })
      // Second call is for the entry within
      .mockResolvedValueOnce({
        manifest: {
          apiVersion: 'v1',
          metadata: { name: 'starter', displayName: 'Starter' },
          entries: [{ name: 'starter', path: '.' }],
        },
        sourcePath: '/tmp/cloned-repo/catalogs/official',
      });
    vi.mocked(templates.flattenManifestEntries).mockReturnValue([
      { templatePath: '.', templateName: 'starter', displayPath: ['starter'] },
    ]);

    await handleExternalTemplate(
      'https://github.com/org/repo.git',
      '/tmp/test',
      'plain',
      { nonInteractive: true, registryPath: 'catalogs/official' }
    );

    // resolveEntryPath should have been called with the registry path first
    expect(templates.resolveEntryPath).toHaveBeenCalledWith(
      '/tmp/cloned-repo',
      'catalogs/official'
    );
  });

  it('wraps fetch failures as handled CLI errors', async () => {
    vi.mocked(gitTemplates.fetchTemplate).mockRejectedValue(
      new Error(
        'git is not available on PATH. Git is required to use templates from private repositories.'
      )
    );

    const error = await handleExternalTemplate(
      'https://github.com/org/private-repo.git',
      '/tmp/test',
      'plain',
      { nonInteractive: true }
    ).catch((err) => err);

    expect(error).toMatchObject({ name: 'CliHandledError' });

    expect(templates.instantiateTemplate).not.toHaveBeenCalled();
    expect(error.message).toContain('Git is required');
  });
});
