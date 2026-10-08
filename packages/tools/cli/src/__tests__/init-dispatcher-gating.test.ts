/**
 * Dispatcher persistence tests — verify that `persistFabricEnvOverrides()` is
 * called only after scaffold handlers complete successfully, never when they
 * throw cancellation.
 *
 * This file exists because the picker → external dispatch sites (registry
 * pick + raw-URL pick) are only reachable in interactive mode; the e2e
 * suite runs non-interactively (CI=true) and can't exercise them.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

// vi.mock() is hoisted before module-level `const`. Declare mock fns
// inside vi.hoisted() so they're available to the mock factories.
const mocks = vi.hoisted(() => ({
  handleExternalTemplate: vi.fn<() => Promise<{ targetPath: string }>>(),
  handleBundledTemplate: vi.fn<() => Promise<{ targetPath: string }>>(),
  upsertEnvVariables: vi.fn<() => Promise<void>>(),
}));

vi.mock('../commands/init-external-template.js', () => ({
  handleExternalTemplate: mocks.handleExternalTemplate,
}));

vi.mock('../utils/env-file-utils.js', () => ({
  upsertEnvVariables: mocks.upsertEnvVariables,
}));

// This suite asserts on the bundled Data App registry's *stable* ref
// (`#v1`). `discoverRegistryEntries()` picks the channel ref based on the
// running CLI's own package version, so leaving that unpinned makes these
// assertions depend on whatever prerelease version happens to be checked
// out (e.g. a local `-alpha` dev build resolving to the alpha channel
// instead of stable). Pin it to a stable version so dispatcher-persistence
// behavior is what's under test here, not channel selection.
vi.mock('../utils/version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/version.js')>();
  return {
    ...actual,
    getPackageVersion: () => '1.0.0',
  };
});

const handleExternalTemplateMock = mocks.handleExternalTemplate;
const handleBundledTemplateMock = mocks.handleBundledTemplate;
const upsertEnvVariablesMock = mocks.upsertEnvVariables;

vi.mock('../commands/init-bundled-template.js', () => ({
  handleBundledTemplate: mocks.handleBundledTemplate,
}));

import { init } from '../commands/init';

const ORIGIN_ID = '9f970daa-6101-4df2-98f9-e0d86e975c61';

describe('init dispatcher Fabric env persistence', () => {
  let testDir: string;
  let originalCwd: string;
  let logSpy: Mock | undefined;
  let errorSpy: Mock | undefined;
  let warnSpy: Mock | undefined;
  let stderrSpy: Mock | undefined;
  let originalIsTTY: boolean | undefined;
  let originalCI: string | undefined;
  let promptSpy: Mock | undefined;

  beforeEach(async () => {
    originalCI = process.env.CI;
    delete process.env.CI;

    // Stub process.exit so misbehaving handler code can't crash the
    // test runner (no assertions on it — handlers throw post-S3-1).
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined) as unknown as Mock;
    errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined) as unknown as Mock;
    warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined) as unknown as Mock;
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as Mock;

    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });

    testDir = join(tmpdir(), `rayfin-dispatcher-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);

    handleExternalTemplateMock.mockReset();
    handleBundledTemplateMock.mockReset();
    upsertEnvVariablesMock.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    warnSpy?.mockRestore();
    stderrSpy?.mockRestore();
    promptSpy?.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    if (originalCI !== undefined) {
      process.env.CI = originalCI;
    } else {
      delete process.env.CI;
    }
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Generic helper: stub a scaffold handler mock to mimic a successful
   * scaffold by writing a minimal `rayfin/rayfin.yml` into the target
   * directory (so the `persistFabricEnvOverrides()` no-op guard sees a
   * "real" rayfin project) and returning its target path. For 'cancelled',
   * throws ScaffoldCancelledError directly — handlers throw on cancel,
   * dispatchers don't gate on a return discriminator.
   */
  function stubHandler(
    mockFn: {
      mockImplementation: (impl: () => Promise<{ targetPath: string }>) => void;
    },
    result: 'completed' | 'cancelled'
  ): void {
    mockFn.mockImplementation(async () => {
      if (result === 'cancelled') {
        const { ScaffoldCancelledError } = await import('../errors.js');
        throw new ScaffoldCancelledError();
      }
      const targetDir = join(testDir, 'app');
      await mkdir(join(targetDir, 'rayfin'), { recursive: true });
      await writeFile(
        join(targetDir, 'rayfin', 'rayfin.yml'),
        'id: app\nname: app\n',
        'utf8'
      );
      return { targetPath: targetDir };
    });
  }

  const stubExternalHandler = (result: 'completed' | 'cancelled') =>
    stubHandler(handleExternalTemplateMock, result);

  const stubBundledHandler = (result: 'completed' | 'cancelled') =>
    stubHandler(handleBundledTemplateMock, result);

  describe('non-interactive --template <url> path', () => {
    beforeEach(() => {
      // Override beforeEach's TTY=true to make this branch non-interactive.
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
    });

    it('calls upsertEnvVariables when external handler completes (non-interactive --template)', async () => {
      stubExternalHandler('completed');

      const command = init();
      await command
        .parseAsync(
          [
            '-t',
            'https://github.com/org/template',
            '--base-api-url',
            'https://api.fabric.microsoft.com/v1',
            'app',
          ],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(upsertEnvVariablesMock).toHaveBeenCalledTimes(1);
    });

    it('persists project provenance after external scaffold success', async () => {
      stubExternalHandler('completed');

      const command = init({ getProjectOriginId: () => ORIGIN_ID });
      await command.parseAsync(
        ['-t', 'https://github.com/org/template', 'app'],
        { from: 'user' }
      );

      await expect(
        readFile(join(testDir, 'app', 'rayfin', '.project.json'), 'utf8')
      ).resolves.toContain(`"projectOriginId": "${ORIGIN_ID}"`);
    });

    it('does NOT call upsertEnvVariables when external handler throws cancellation', async () => {
      stubExternalHandler('cancelled');

      const command = init();
      await command
        .parseAsync(
          [
            '-t',
            'https://github.com/org/template',
            '--base-api-url',
            'https://api.fabric.microsoft.com/v1',
            'app',
          ],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(upsertEnvVariablesMock).not.toHaveBeenCalled();
    });
  });

  describe('interactive picker → "Use an external git template" path', () => {
    async function pickExternalAndPromptForUrl(): Promise<void> {
      const inquirerModule = await import('inquirer');
      promptSpy = vi
        .spyOn(inquirerModule.default, 'prompt')

        .mockImplementation(async (questions: any) => {
          const q = Array.isArray(questions) ? questions[0] : questions;
          if (q.name === 'source') return { source: 'external' };
          if (q.name === 'gitUrl')
            return { gitUrl: 'https://github.com/org/template.git' };
          return {};
        }) as unknown as Mock;
    }

    it('calls upsertEnvVariables when handler completes', async () => {
      await pickExternalAndPromptForUrl();
      stubExternalHandler('completed');

      const command = init();
      await command
        .parseAsync(
          ['--base-api-url', 'https://api.fabric.microsoft.com/v1', 'app'],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      // Regression: previously the picker branch dropped the discriminator
      // and never called persistFabricEnvOverrides for any outcome.
      expect(upsertEnvVariablesMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT call upsertEnvVariables when handler throws cancellation', async () => {
      await pickExternalAndPromptForUrl();
      stubExternalHandler('cancelled');

      const command = init();
      await command
        .parseAsync(
          ['--base-api-url', 'https://api.fabric.microsoft.com/v1', 'app'],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(upsertEnvVariablesMock).not.toHaveBeenCalled();
    });
  });

  describe('interactive picker → "Use a template" path', () => {
    it('lists the requested default template label first and scaffolds directly', async () => {
      const inquirerModule = await import('inquirer');
      promptSpy = vi
        .spyOn(inquirerModule.default, 'prompt')
        .mockImplementation(async (questions: any) => {
          const q = Array.isArray(questions) ? questions[0] : questions;
          if (q.name === 'source') {
            expect(q.choices.slice(0, 2)).toEqual([
              {
                name: '✨ Use default template',
                value: 'default-universal',
              },
              {
                name: '📦 Use a template (built-in)',
                value: 'template',
              },
            ]);
            return { source: 'default-universal' };
          }
          return {};
        }) as unknown as Mock;
      stubBundledHandler('completed');

      const command = init();
      await command.parseAsync(['app'], { from: 'user' });

      expect(handleBundledTemplateMock).toHaveBeenCalledWith(
        'app',
        expect.anything(),
        expect.objectContaining({
          template: 'universal-app',
          nonInteractive: false,
        })
      );
      expect(handleExternalTemplateMock).not.toHaveBeenCalled();
    });

    async function pickBuiltInDataApp(): Promise<void> {
      const inquirerModule = await import('inquirer');
      promptSpy = vi
        .spyOn(inquirerModule.default, 'prompt')
        .mockImplementation(async (questions: any) => {
          const q = Array.isArray(questions) ? questions[0] : questions;
          if (q.name === 'source') return { source: 'template' };
          if (q.name === 'template') return { template: { name: 'dataapp' } };
          return {};
        }) as unknown as Mock;
    }

    it('routes first-class bundled picker selections through the registry override', async () => {
      await pickBuiltInDataApp();
      stubExternalHandler('completed');

      const command = init();
      await command.parseAsync(['app'], { from: 'user' }).catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        'https://github.com/microsoft/fabric-apps-analytic-templates#v1',
        'app',
        expect.anything(),
        expect.objectContaining({
          templateName: 'Data App',
          nonInteractive: false,
        })
      );
      expect(handleBundledTemplateMock).not.toHaveBeenCalled();
    });
  });

  describe('non-interactive --template <bundled-name> path', () => {
    beforeEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
    });

    it('calls upsertEnvVariables when bundled handler completes', async () => {
      stubBundledHandler('completed');

      const command = init();
      await command
        .parseAsync(
          [
            '--template',
            'blankapp',
            '--base-api-url',
            'https://api.fabric.microsoft.com/v1',
            'app',
          ],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleBundledTemplateMock).toHaveBeenCalledTimes(1);
      expect(upsertEnvVariablesMock).toHaveBeenCalledTimes(1);
    });

    it('persists project provenance after bundled scaffold success', async () => {
      stubBundledHandler('completed');

      const command = init({ getProjectOriginId: () => ORIGIN_ID });
      await command.parseAsync(['--template', 'blankapp', 'app'], {
        from: 'user',
      });

      await expect(
        readFile(join(testDir, 'app', 'rayfin', '.project.json'), 'utf8')
      ).resolves.toContain(`"projectOriginId": "${ORIGIN_ID}"`);
    });

    it('does not persist provenance when the scaffold has no rayfin.yml', async () => {
      handleBundledTemplateMock.mockResolvedValue({
        targetPath: join(testDir, 'app'),
      });

      const command = init({ getProjectOriginId: () => ORIGIN_ID });
      await command.parseAsync(['--template', 'blankapp', 'app'], {
        from: 'user',
      });

      await expect(
        readFile(join(testDir, 'app', 'rayfin', '.project.json'), 'utf8')
      ).rejects.toThrow();
    });

    it('does not persist provenance when telemetry is opted out', async () => {
      stubBundledHandler('completed');

      const command = init({
        createProjectSemantics: true,
        getProjectOriginId: () => undefined,
      });
      await command.parseAsync(['--template', 'blankapp', 'app'], {
        from: 'user',
      });

      await expect(
        readFile(join(testDir, 'app', 'rayfin', '.project.json'), 'utf8')
      ).rejects.toThrow();
    });

    it('keeps scaffold success when provenance persistence fails', async () => {
      stubBundledHandler('completed');
      const persistProjectOrigin = vi
        .fn()
        .mockRejectedValue(new Error('disk full'));

      const command = init({
        getProjectOriginId: () => ORIGIN_ID,
        projectOriginWriter: { persistProjectOrigin },
      });
      await expect(
        command.parseAsync(['--template', 'blankapp', 'app'], { from: 'user' })
      ).resolves.toBeDefined();

      expect(persistProjectOrigin).toHaveBeenCalledWith(
        join(testDir, 'app'),
        ORIGIN_ID
      );
    });

    it('does NOT call upsertEnvVariables when bundled handler throws cancellation', async () => {
      // Cancellation must stop before Fabric env overrides are persisted into
      // a project the user never agreed to scaffold.
      stubBundledHandler('cancelled');

      const command = init();
      await command
        .parseAsync(
          [
            '--template',
            'blankapp',
            '--base-api-url',
            'https://api.fabric.microsoft.com/v1',
            'app',
          ],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleBundledTemplateMock).toHaveBeenCalledTimes(1);
      expect(upsertEnvVariablesMock).not.toHaveBeenCalled();
    });

    it('does not persist project provenance after cancellation', async () => {
      stubBundledHandler('cancelled');

      const command = init({ getProjectOriginId: () => ORIGIN_ID });
      await expect(
        command.parseAsync(['--template', 'blankapp', 'app'], { from: 'user' })
      ).rejects.toThrow();

      await expect(
        readFile(join(testDir, 'app', 'rayfin', '.project.json'), 'utf8')
      ).rejects.toThrow();
    });

    it('falls back to bundled dataapp when the first-class registry path fails', async () => {
      const { CliHandledError } = await import('../errors.js');
      handleExternalTemplateMock.mockImplementation(async () => {
        throw new CliHandledError(new Error('network unavailable'));
      });
      stubBundledHandler('completed');

      const command = init();
      await command
        .parseAsync(
          [
            '--template',
            'dataapp',
            '--base-api-url',
            'https://api.fabric.microsoft.com/v1',
            'app',
          ],
          { from: 'user' }
        )
        .catch(() => {});

      const pinnedDataAppRegistryUrl =
        'https://github.com/microsoft/fabric-apps-analytic-templates#v1';
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        pinnedDataAppRegistryUrl,
        'app',
        expect.anything(),
        expect.objectContaining({
          templateName: 'Data App',
          nonInteractive: true,
        })
      );
      expect(handleBundledTemplateMock).toHaveBeenCalledWith(
        'app',
        expect.anything(),
        expect.objectContaining({
          template: 'dataapp',
          nonInteractive: true,
        })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('falling back to bundled "dataapp"')
      );
      expect(upsertEnvVariablesMock).toHaveBeenCalledTimes(1);
    });

    it('persists provenance for the successful bundled fallback', async () => {
      const { CliHandledError } = await import('../errors.js');
      handleExternalTemplateMock.mockRejectedValue(
        new CliHandledError(new Error('network unavailable'))
      );
      stubBundledHandler('completed');

      const command = init({ getProjectOriginId: () => ORIGIN_ID });
      await command.parseAsync(['--template', 'dataapp', 'app'], {
        from: 'user',
      });

      await expect(
        readFile(join(testDir, 'app', 'rayfin', '.project.json'), 'utf8')
      ).resolves.toContain(`"projectOriginId": "${ORIGIN_ID}"`);
    });

    it('does not fall back when first-class registry scaffolding is cancelled', async () => {
      const { ScaffoldCancelledError } = await import('../errors.js');
      handleExternalTemplateMock.mockImplementation(async () => {
        throw new ScaffoldCancelledError();
      });
      stubBundledHandler('completed');

      const command = init();
      await command
        .parseAsync(['--template', 'dataapp', 'app'], { from: 'user' })
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleBundledTemplateMock).not.toHaveBeenCalled();
      expect(upsertEnvVariablesMock).not.toHaveBeenCalled();
    });
  });

  describe('create-project directory semantics (explicit `.` vs omitted)', () => {
    const ANALYTIC_TEMPLATE_URL =
      'https://github.com/microsoft/fabric-apps-analytic-templates';

    beforeEach(() => {
      // These assertions exercise the non-interactive `-t <url>` dispatch.
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
    });

    // The Fabric portal emits exactly this command. An explicit `.` must
    // scaffold in place (useProjectNameAsDirectory=false), NOT nest the
    // project under a `rayfin-lyra/` child directory.
    it('disables useProjectNameAsDirectory when an explicit `.` is passed', async () => {
      stubExternalHandler('completed');

      const command = init({ createProjectSemantics: true });
      await command
        .parseAsync(
          ['.', '--project-name', 'rayfin-lyra', '-t', ANALYTIC_TEMPLATE_URL],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        ANALYTIC_TEMPLATE_URL,
        '.',
        expect.anything(),
        expect.objectContaining({
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: false,
        })
      );
    });

    // The bare `npm create @microsoft/rayfin` flow (no positional directory)
    // still uses the project name as the child directory.
    it('keeps useProjectNameAsDirectory enabled when the directory is omitted', async () => {
      stubExternalHandler('completed');

      const command = init({ createProjectSemantics: true });
      await command
        .parseAsync(
          ['--project-name', 'rayfin-lyra', '-t', ANALYTIC_TEMPLATE_URL],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        ANALYTIC_TEMPLATE_URL,
        '.',
        expect.anything(),
        expect.objectContaining({
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: true,
        })
      );
    });

    // Without create-project semantics (plain `rayfin init`),
    // useProjectNameAsDirectory is never set regardless of the positional.
    it('never sets useProjectNameAsDirectory for plain `rayfin init`', async () => {
      stubExternalHandler('completed');

      const command = init();
      await command
        .parseAsync(['-t', ANALYTIC_TEMPLATE_URL], { from: 'user' })
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        ANALYTIC_TEMPLATE_URL,
        '.',
        expect.anything(),
        expect.objectContaining({ useProjectNameAsDirectory: false })
      );
    });

    // The discriminator is "was a positional provided", not "is the value
    // literally `.`" — so any explicit in-place-looking form (`./`, etc.) also
    // disables the nest-under-project-name behavior and scaffolds in place.
    it('disables useProjectNameAsDirectory for an explicit `./` form', async () => {
      stubExternalHandler('completed');

      const command = init({ createProjectSemantics: true });
      await command
        .parseAsync(
          ['./', '--project-name', 'rayfin-lyra', '-t', ANALYTIC_TEMPLATE_URL],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        ANALYTIC_TEMPLATE_URL,
        './',
        expect.anything(),
        expect.objectContaining({
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: false,
        })
      );
    });

    // Side-effect contract: because an explicit `.` now scaffolds in place,
    // `create-rayfin . -t <url>` WITHOUT --project-name no longer nests under a
    // derived child directory — it dispatches the external template in place
    // (projectName left undefined for downstream cwd-basename resolution). The
    // Fabric portal always passes --project-name, so this only affects manual
    // invocations. Documented here so the behavior is intentional, not drift.
    it('scaffolds in place for explicit `.` even without --project-name', async () => {
      stubExternalHandler('completed');

      const command = init({ createProjectSemantics: true });
      await command
        .parseAsync(['.', '-t', ANALYTIC_TEMPLATE_URL], { from: 'user' })
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        ANALYTIC_TEMPLATE_URL,
        '.',
        expect.anything(),
        expect.objectContaining({
          projectName: undefined,
          useProjectNameAsDirectory: false,
        })
      );
    });

    // A bare sub-directory positional is "provided", so nest-under-project-name
    // is disabled and the directory is threaded through verbatim (the scaffold
    // pipeline creates `./my-app/`).
    it('passes a sub-directory through verbatim with useProjectNameAsDirectory false', async () => {
      stubExternalHandler('completed');

      const command = init({ createProjectSemantics: true });
      await command
        .parseAsync(
          [
            'my-app',
            '--project-name',
            'rayfin-lyra',
            '-t',
            ANALYTIC_TEMPLATE_URL,
          ],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        ANALYTIC_TEMPLATE_URL,
        'my-app',
        expect.anything(),
        expect.objectContaining({
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: false,
        })
      );
    });

    // A sibling directory positional is honored literally — the project
    // scaffolds into `../sibling-dir/`, never nested under the project name.
    it('passes a sibling directory (`../sibling-dir/`) through verbatim', async () => {
      stubExternalHandler('completed');

      const command = init({ createProjectSemantics: true });
      await command
        .parseAsync(
          [
            '../sibling-dir/',
            '--project-name',
            'rayfin-lyra',
            '-t',
            ANALYTIC_TEMPLATE_URL,
          ],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        ANALYTIC_TEMPLATE_URL,
        '../sibling-dir/',
        expect.anything(),
        expect.objectContaining({
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: false,
        })
      );
    });

    // `createProjectSemantics` is the single source of truth for nest-under-
    // project-name. The command name is irrelevant: a command named
    // 'create-rayfin' built WITHOUT the option does NOT nest, even when the
    // directory is omitted. Production create-rayfin always passes the option
    // (see packages/tools/create-rayfin/src/index.ts), so this only pins the
    // contract that behavior follows the option, not the display name.
    it('does not nest based on the command name alone (option is the source of truth)', async () => {
      stubExternalHandler('completed');

      const command = init();
      command.name('create-rayfin');
      await command
        .parseAsync(
          ['--project-name', 'rayfin-lyra', '-t', ANALYTIC_TEMPLATE_URL],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleExternalTemplateMock).toHaveBeenCalledWith(
        ANALYTIC_TEMPLATE_URL,
        '.',
        expect.anything(),
        expect.objectContaining({ useProjectNameAsDirectory: false })
      );
    });

    // POSIX-skipped: `\` is a literal filename char off win32, so `.\` only
    // resolves to cwd on Windows. `.\` is the standard PowerShell spelling for
    // "scaffold here" and must disable nest-under-project-name like `.`/`./`.
    it.skipIf(process.platform !== 'win32')(
      'disables useProjectNameAsDirectory for an explicit ".\\" (Windows)',
      async () => {
        stubExternalHandler('completed');

        const command = init({ createProjectSemantics: true });
        await command
          .parseAsync(
            [
              '.\\',
              '--project-name',
              'rayfin-lyra',
              '-t',
              ANALYTIC_TEMPLATE_URL,
            ],
            { from: 'user' }
          )
          .catch(() => {});

        expect(handleExternalTemplateMock).toHaveBeenCalledTimes(1);
        expect(handleExternalTemplateMock).toHaveBeenCalledWith(
          ANALYTIC_TEMPLATE_URL,
          '.\\',
          expect.anything(),
          expect.objectContaining({
            projectName: 'rayfin-lyra',
            useProjectNameAsDirectory: false,
          })
        );
      }
    );

    // The gate is threaded into both the external and bundled dispatch sinks
    // from the same local. Pin the bundled sink too so a regression that only
    // re-nests the bundled path can't slip through unverified.
    it('disables useProjectNameAsDirectory on the bundled path for explicit `.`', async () => {
      stubBundledHandler('completed');

      const command = init({ createProjectSemantics: true });
      await command
        .parseAsync(
          [
            '.',
            '--project-name',
            'rayfin-lyra',
            '--template',
            'blankapp',
            '--base-api-url',
            'https://api.fabric.microsoft.com/v1',
          ],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleBundledTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleBundledTemplateMock).toHaveBeenCalledWith(
        '.',
        expect.anything(),
        expect.objectContaining({
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: false,
        })
      );
    });

    it('keeps useProjectNameAsDirectory enabled on the bundled path when omitted', async () => {
      stubBundledHandler('completed');

      const command = init({ createProjectSemantics: true });
      await command
        .parseAsync(
          [
            '--project-name',
            'rayfin-lyra',
            '--template',
            'blankapp',
            '--base-api-url',
            'https://api.fabric.microsoft.com/v1',
          ],
          { from: 'user' }
        )
        .catch(() => {});

      expect(handleBundledTemplateMock).toHaveBeenCalledTimes(1);
      expect(handleBundledTemplateMock).toHaveBeenCalledWith(
        '.',
        expect.anything(),
        expect.objectContaining({
          projectName: 'rayfin-lyra',
          useProjectNameAsDirectory: true,
        })
      );
    });
  });
});
