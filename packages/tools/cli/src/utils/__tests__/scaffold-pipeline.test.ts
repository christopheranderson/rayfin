import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock() is hoisted to the top of the file BEFORE module-level `const`
// initialization. Declare mock fns inside vi.hoisted() so they're available
// to the mock factory.
const mocks = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
  rmSync: vi.fn<(p: string, opts?: unknown) => void>(),
  promptProjectName: vi
    .fn<(defaultName?: string) => Promise<string>>()
    .mockImplementation(async (defaultName?: string) => defaultName ?? ''),
  customizeTemplate: vi.fn(),
  installDependencies: vi.fn<(targetPath: string) => Promise<void>>(),
  hydrateDeploymentFromFabric: vi.fn<
    () => Promise<{
      workspaceDisplayName: string;
      baasEndpoint: string;
      publishableKey: string;
      envFilePath: string;
    }>
  >(),
  runRayfinInitFromTemplate:
    vi.fn<
      (
        targetPath: string,
        projectName: string,
        dialect: string | undefined,
        artifactContext:
          | { workspaceId?: string; itemId?: string; baseApiUrl?: string }
          | undefined,
        options:
          | { skipInstall?: boolean; skipRayfinPackageInstall?: boolean }
          | undefined
      ) => Promise<void>
    >(),
  upsertEnvVariables: vi.fn<() => Promise<void>>(),
}));

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mocks.existsSync,
    rmSync: mocks.rmSync,
  };
});

vi.mock('../template-scaffold.js', async (importActual) => {
  const actual = await importActual<typeof import('../template-scaffold.js')>();
  return {
    ...actual,
    promptProjectName: mocks.promptProjectName,
    customizeTemplate: mocks.customizeTemplate,
    installDependencies: mocks.installDependencies,
    runRayfinInitFromTemplate: mocks.runRayfinInitFromTemplate,
  };
});

vi.mock('../env-file-utils.js', () => ({
  upsertEnvVariables: mocks.upsertEnvVariables,
}));

vi.mock('../hydrate-deployment.js', () => ({
  hydrateDeploymentFromFabric: mocks.hydrateDeploymentFromFabric,
}));

const existsSyncMock = mocks.existsSync;
const rmSyncMock = mocks.rmSync;
const promptProjectNameMock = mocks.promptProjectName;
const customizeTemplateMock = mocks.customizeTemplate;
const installDependenciesMock = mocks.installDependencies;
const hydrateDeploymentFromFabricMock = mocks.hydrateDeploymentFromFabric;
const runRayfinInitFromTemplateMock = mocks.runRayfinInitFromTemplate;

import { ScaffoldCancelledError } from '../../errors.js';
import {
  assertTargetConflictOrThrow,
  checkTargetConflict,
  formatCdTarget,
  isInPlaceDirectory,
  printNextStepsBanner,
  resolveProjectName,
  resolveScaffoldTarget,
  runScaffoldPipeline,
  slugifyDirectoryArg,
  wipeTargetDirectory,
} from '../scaffold-pipeline.js';

describe('printNextStepsBanner', () => {
  it('prints the unified dev command after changing into a new project', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printNextStepsBanner('interactive', 'my-app', false);

    expect(log.mock.calls.map(([message]) => message)).toEqual([
      '\n🎉 Project created successfully!\n',
      'Next steps:\n',
      '  cd my-app',
      '  npx rayfin dev\n',
    ]);
    log.mockRestore();
  });

  it('omits cd when scaffolding in place', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printNextStepsBanner('interactive', '.', true);

    expect(log.mock.calls.map(([message]) => message)).toEqual([
      '\n🎉 Project created successfully!\n',
      'Next steps:\n',
      '  npx rayfin dev\n',
    ]);
    log.mockRestore();
  });
});

describe('resolveProjectName', () => {
  beforeEach(() => {
    promptProjectNameMock.mockClear();
    promptProjectNameMock.mockImplementation(
      async (defaultName?: string) => defaultName ?? ''
    );
  });

  describe('explicit projectName', () => {
    it('returns the explicit name when valid', async () => {
      const result = await resolveProjectName({
        explicitProjectName: 'my-cool-app',
        directory: '/anywhere/else',
        inPlace: false,
      });
      expect(result).toBe('my-cool-app');
    });

    it('returns the explicit name preserving display form (spaces)', async () => {
      const result = await resolveProjectName({
        explicitProjectName: 'My Cool App',
        directory: '/somewhere',
        inPlace: false,
      });
      expect(result).toBe('My Cool App');
    });

    it('throws on invalid explicit projectName', async () => {
      await expect(
        resolveProjectName({
          explicitProjectName: '!!!',
          directory: '/somewhere',
          inPlace: false,
        })
      ).rejects.toThrow(/Invalid project name/);
    });
  });

  describe('directory-basename fallback', () => {
    it('uses directory basename when projectName is omitted', async () => {
      const result = await resolveProjectName({
        directory: '/tmp/parent/my-app',
        inPlace: false,
        nonInteractive: true,
      });
      expect(result).toBe('my-app');
    });

    it('uses directory basename even when nonInteractive is unspecified', async () => {
      const result = await resolveProjectName({
        directory: '/tmp/parent/another-app',
        inPlace: false,
      });
      expect(result).toBe('another-app');
    });

    it('sanitizes an invalid basename in non-interactive mode instead of throwing', async () => {
      // Cache directories created by `npm create` / `npx` can have
      // basenames containing characters not allowed in project names
      // (e.g. `@`, `+`, `.`). Rather than fail with an unrecoverable
      // error, the resolver sanitizes the basename so automation can
      // keep flowing.
      const result = await resolveProjectName({
        directory: '/tmp/@microsoft+create-rayfin@latest',
        inPlace: true,
        nonInteractive: true,
      });
      // `@microsoft+create-rayfin@latest` → `microsoft-create-rayfin-latest`
      expect(result).toBe('microsoft-create-rayfin-latest');
    });

    it('falls back to the default placeholder name when the basename has nothing salvageable', async () => {
      // A directory whose basename is composed entirely of disallowed
      // characters (no alphanumerics) sanitizes to the empty string;
      // the resolver then returns the placeholder so callers can
      // proceed without prompting.
      const result = await resolveProjectName({
        directory: '/tmp/!!!',
        inPlace: false,
        nonInteractive: true,
      });
      expect(result).toBe('rayfin-app');
    });

    it('in-place: derives basename from params.directory, not process.cwd()', async () => {
      // The function must be deterministic from its parameters. Pass an
      // absolute directory distinct from cwd; verify the result derives
      // from that parameter rather than the current working directory.
      const result = await resolveProjectName({
        directory: '/tmp/some-other-dir/derived-from-param',
        inPlace: true,
        nonInteractive: true,
      });
      expect(result).toBe('derived-from-param');
    });

    it('in-place: throws when params.directory has empty basename (filesystem root)', async () => {
      // `basename('/')` is empty. The in-place branch must surface a
      // meaningful error instead of falling through to the prompt.
      await expect(
        resolveProjectName({
          directory: '/',
          inPlace: true,
          nonInteractive: true,
        })
      ).rejects.toThrow(/Cannot scaffold into the filesystem root/);
    });
  });

  describe('precedence', () => {
    it('explicit projectName wins over directory basename', async () => {
      const result = await resolveProjectName({
        explicitProjectName: 'Custom Name',
        directory: '/tmp/parent/positional-name',
        inPlace: false,
      });
      expect(result).toBe('Custom Name');
    });
  });

  // The prompt-skipping behavior is the load-bearing UX guarantee for
  // `create-rayfin "My App"` and `rayfin init "My App"`: the user already
  // chose a name via the positional, so we must not re-ask. Subprocess
  // e2e tests can't validate this (no TTY → always non-interactive), so
  // these unit tests are the only place this is enforced.
  describe('prompt control (interactive mode)', () => {
    it('positional directory: skips prompt and returns basename', async () => {
      const result = await resolveProjectName({
        directory: '/tmp/parent/My App',
        inPlace: false,
        // nonInteractive omitted → interactive path
      });
      expect(result).toBe('My App');
      expect(promptProjectNameMock).not.toHaveBeenCalled();
    });

    it('explicit --project-name: skips prompt and returns the name', async () => {
      const result = await resolveProjectName({
        explicitProjectName: 'My App',
        directory: '/tmp/parent/positional-name',
        inPlace: false,
      });
      expect(result).toBe('My App');
      expect(promptProjectNameMock).not.toHaveBeenCalled();
    });

    it('in-place (directory="."): prompts with cwd basename as default', async () => {
      promptProjectNameMock.mockResolvedValueOnce('Prompted Answer');
      const result = await resolveProjectName({
        directory: '/tmp/parent/cwd-basename',
        inPlace: true,
      });
      expect(promptProjectNameMock).toHaveBeenCalledTimes(1);
      expect(promptProjectNameMock).toHaveBeenCalledWith('cwd-basename');
      expect(result).toBe('Prompted Answer');
    });

    it('positional with invalid basename: falls back to prompt with safe default', async () => {
      // basename "!!!" is not a valid project name (no alphanumerics);
      // fall through to the prompt rather than returning an invalid name.
      // The prompt must NOT receive the invalid basename as its default —
      // that would make Enter trip validation. Use a safe placeholder.
      promptProjectNameMock.mockResolvedValueOnce('Recovered Name');
      const result = await resolveProjectName({
        directory: '/tmp/parent/!!!',
        inPlace: false,
      });
      expect(promptProjectNameMock).toHaveBeenCalledTimes(1);
      expect(promptProjectNameMock).toHaveBeenCalledWith('My Rayfin App');
      expect(result).toBe('Recovered Name');
    });
  });
});

// `slugifyDirectoryArg` makes the on-disk directory filesystem-friendly
// when the positional contains whitespace (e.g. "My App") — the only
// case that actually causes shell-hostility. Other inputs pass through
// literally, since `MyApp/`, `App_2/`, etc. work fine as directories.
describe('slugifyDirectoryArg', () => {
  describe('whitespace in bare name', () => {
    it('slugifies a positional with a single space', () => {
      expect(slugifyDirectoryArg('My App')).toBe('my-app');
    });

    it('slugifies a positional with multiple spaces', () => {
      expect(slugifyDirectoryArg('My  App')).toBe('my-app');
    });

    it('slugifies a positional with a tab', () => {
      expect(slugifyDirectoryArg('My\tApp')).toBe('my-app');
    });
  });

  describe('bare name without whitespace (passthrough)', () => {
    it('preserves an already-slug positional', () => {
      expect(slugifyDirectoryArg('my-app')).toBe('my-app');
    });

    it('preserves CamelCase', () => {
      // CamelCase has no shell-hostility — `MyApp/` works on every
      // filesystem. Don't surprise the user by lowercasing what they
      // typed; let the project-identity layer (rayfin.yml.id,
      // package.json.name) handle slug normalization separately.
      expect(slugifyDirectoryArg('MyApp')).toBe('MyApp');
    });

    it('preserves underscores', () => {
      expect(slugifyDirectoryArg('my_app')).toBe('my_app');
      expect(slugifyDirectoryArg('App_2')).toBe('App_2');
    });

    it('preserves mixed-case with hyphens', () => {
      expect(slugifyDirectoryArg('My-App')).toBe('My-App');
    });
  });

  describe('path-like positional (escape hatch)', () => {
    it('respects relative paths with separators (including with whitespace)', () => {
      // Users who genuinely want `My App/` pass `./My App` to
      // disambiguate "this is a path" from "this is a project name".
      expect(slugifyDirectoryArg('./My App')).toBe('./My App');
      expect(slugifyDirectoryArg('./projects/my-app')).toBe(
        './projects/my-app'
      );
    });

    it('respects parent-relative paths', () => {
      expect(slugifyDirectoryArg('../my-app')).toBe('../my-app');
    });

    it('respects backslash separators (Windows)', () => {
      expect(slugifyDirectoryArg('projects\\my-app')).toBe('projects\\my-app');
    });

    it('respects absolute POSIX paths', () => {
      expect(slugifyDirectoryArg('/tmp/my-app')).toBe('/tmp/my-app');
    });
  });

  describe('in-place', () => {
    it('respects "."', () => {
      expect(slugifyDirectoryArg('.')).toBe('.');
    });

    it('respects "./"', () => {
      expect(slugifyDirectoryArg('./')).toBe('./');
    });
  });

  describe('degenerate inputs', () => {
    it('returns the original when slugify yields empty (e.g. "   ")', () => {
      // Whitespace-only triggers the slugify branch (whitespace test passes),
      // generateProjectSlug returns "" (trimmed empty). The fallback keeps
      // the original so downstream code can surface a meaningful validation
      // error rather than silently scaffolding into "".
      expect(slugifyDirectoryArg('   ')).toBe('   ');
    });

    // Council-B caught this in pre-push round 2 deep-review: without a
    // slug-shape allow list, whitespace-padded path metasegments (`" . "`,
    // `" .. "`) would slugify to `.` / `..` — paths that `path.resolve`
    // collapses to cwd or its parent. Combined with the dispatcher's
    // non-in-place branch (because `isInPlaceDirectory` checks the raw
    // input which has whitespace and resolves to a literal child),
    // this could route a bare `--overwrite` into wiping cwd or the
    // parent directory. The allow list rejects any slug that isn't in
    // PROJECT_SLUG_REGEX shape and falls back to the literal directory.
    it('rejects slug "." (would resolve to cwd)', () => {
      // generateProjectSlug(" . ") returns "."; without the allow list,
      // resolveScaffoldTarget({ directory: " . ", ... }) would produce
      // cwd — the wipe target.
      // With the allow list, slug "." is rejected and the fallback
      // returns the literal " . " (which path.resolve treats as a
      // child directory named " . ", not cwd).
      expect(slugifyDirectoryArg(' . ')).toBe(' . ');
    });

    it('rejects slug ".." (would resolve to parent of cwd)', () => {
      // Same shape as above for `..`. Would resolve to parent of cwd
      // — even more dangerous than cwd because the user has no
      // expectation that the parent directory is in scope.
      expect(slugifyDirectoryArg(' .. ')).toBe(' .. ');
    });

    it('rejects slug with leading dot (e.g. ". my-app")', () => {
      // generateProjectSlug(". my-app") returns ".-my-app"; not a
      // valid kebab slug per PROJECT_SLUG_REGEX. Fall back to literal.
      expect(slugifyDirectoryArg('. my-app')).toBe('. my-app');
    });
  });
});

// `formatCdTarget` produces a copy-pasteable `cd <path>` argument for
// success-banner "Next steps" output. POSIX single-quoting handles
// whitespace; idempotent passthrough for already-safe paths.
describe('formatCdTarget', () => {
  describe('no whitespace (passthrough)', () => {
    it('returns simple slugs as-is', () => {
      expect(formatCdTarget('my-app')).toBe('my-app');
    });

    it('returns CamelCase as-is', () => {
      expect(formatCdTarget('MyApp')).toBe('MyApp');
    });

    it('returns relative paths as-is', () => {
      expect(formatCdTarget('./projects/my-app')).toBe('./projects/my-app');
    });

    it('returns absolute paths as-is', () => {
      expect(formatCdTarget('/tmp/my-app')).toBe('/tmp/my-app');
    });

    it('returns parent-relative paths as-is', () => {
      expect(formatCdTarget('../my-app')).toBe('../my-app');
    });
  });

  describe('whitespace (single-quote)', () => {
    it('quotes a path with a space', () => {
      expect(formatCdTarget('My App')).toBe(`'My App'`);
    });

    it('quotes a path-like positional with a space (escape hatch case)', () => {
      // Created by `create-rayfin "./My App"` after slugifyDirectoryArg
      // passes the path-like form through unchanged.
      expect(formatCdTarget('./My App')).toBe(`'./My App'`);
    });

    it('quotes a path with a tab', () => {
      expect(formatCdTarget('My\tApp')).toBe(`'My\tApp'`);
    });
  });

  describe('shell metacharacters without whitespace (Council A + B)', () => {
    // Both Council A and Council B flagged this independently in deep-review:
    // the original `/\s/`-only trigger left bare-name positionals containing
    // shell metacharacters (parens, semicolons, ampersands, `$`, `*`, `?`,
    // etc.) UNQUOTED, producing an unrunnable `cd` line. `App(v2)` is a
    // realistic naming pattern that survives slugify (no whitespace) and
    // would print `cd App(v2)` — bash/zsh syntax error on the parens.
    it('quotes paths with parentheses', () => {
      expect(formatCdTarget('App(v2)')).toBe(`'App(v2)'`);
    });

    it('quotes paths with a semicolon (command-separator hostile)', () => {
      // Concrete failure mode: `cd ./foo;echo-pwned` would execute the
      // second command instead of just changing directories.
      expect(formatCdTarget('./foo;echo-pwned')).toBe(`'./foo;echo-pwned'`);
    });

    it('quotes paths with a dollar sign (interpolation hostile)', () => {
      expect(formatCdTarget('App$VAR')).toBe(`'App$VAR'`);
    });

    it('quotes paths with brackets', () => {
      expect(formatCdTarget('App[v2]')).toBe(`'App[v2]'`);
    });

    it('quotes paths with a plus sign (build-version pattern)', () => {
      expect(formatCdTarget('v1.0.0-rc1+build')).toBe(`'v1.0.0-rc1+build'`);
    });
  });

  describe('embedded single quotes (platform-specific escape)', () => {
    // The CLI prints `cd <path>` for the user to copy-paste. Cross-shell
    // quoting is best-effort: PowerShell on Windows uses doubled
    // apostrophes (`'Bob''s app'`), POSIX shells use the close-reopen
    // ANSI-C trick (`'Bob'\''s app'`). The wrong escape on the wrong
    // shell produces an unterminated-string parse error, which is the
    // bug Council B caught (`./Bob's App` on PowerShell).
    it.skipIf(process.platform === 'win32')(
      "POSIX: escapes single quote via '\\'' close-reopen trick",
      () => {
        expect(formatCdTarget("it's mine")).toBe(`'it'\\''s mine'`);
      }
    );

    it.skipIf(process.platform !== 'win32')(
      'win32: escapes single quote by doubling (PowerShell convention)',
      () => {
        expect(formatCdTarget("it's mine")).toBe(`'it''s mine'`);
      }
    );

    it.skipIf(process.platform !== 'win32')(
      "win32: regression for `./Bob's App` (path-like + whitespace + apostrophe)",
      () => {
        // Concrete failure mode caught by Council B: PowerShell parses
        // `cd './Bob'\''s App'` as an unterminated string. Doubling the
        // apostrophe (`./Bob''s App`) is the correct PowerShell form.
        expect(formatCdTarget("./Bob's App")).toBe(`'./Bob''s App'`);
      }
    );

    // Apostrophe-without-whitespace regression (Copilot review on 194f797f).
    // PowerShell breaks on an unquoted apostrophe even without surrounding
    // whitespace — `cd Bob's-app` parses the apostrophe as a string opener.
    // The post-deep-review regex `[^A-Za-z0-9._\-/\\:]` covers this since
    // apostrophe is not in the safe charset; this test pins the contract.
    it.skipIf(process.platform === 'win32')(
      "POSIX: quotes apostrophe even without whitespace (`Bob's-app`)",
      () => {
        expect(formatCdTarget("Bob's-app")).toBe(`'Bob'\\''s-app'`);
      }
    );

    it.skipIf(process.platform !== 'win32')(
      "win32: quotes apostrophe even without whitespace (`Bob's-app`)",
      () => {
        expect(formatCdTarget("Bob's-app")).toBe(`'Bob''s-app'`);
      }
    );
  });
});

// `isInPlaceDirectory` is the load-bearing guard that decides whether
// the user is scaffolding INTO the cwd (no-prompt) or into a NEW dir
// (where the conflict-prompt + wipe path can run). A literal-string
// check missing `.\` would treat the cwd as a normal target on Windows
// and wipe it on overwrite — a critical data-loss bug Copilot caught.
describe('isInPlaceDirectory', () => {
  beforeEach(() => {
    // Stub process.cwd() so the helper's resolution-based comparison
    // is deterministic regardless of where the test process runs.
    vi.spyOn(process, 'cwd').mockReturnValue('/home/user/work');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canonical in-place forms', () => {
    it('treats "." as in-place', () => {
      expect(isInPlaceDirectory('.')).toBe(true);
    });

    it('treats "./" as in-place', () => {
      expect(isInPlaceDirectory('./')).toBe(true);
    });
  });

  describe('Windows backslash forms (the bug Copilot caught)', () => {
    // POSIX-skipped: on Linux/macOS, `\` is a literal filename character,
    // not a path separator, so `path.resolve(cwd, '.\\')` correctly
    // resolves to a child path (`/cwd/.\\`), not cwd. The behavior under
    // test — "Windows `.\` resolves to cwd" — is platform-specific to
    // win32 because `path.resolve` is platform-native. Production code
    // is correct on both platforms; only this assertion is Windows-only.
    it.skipIf(process.platform !== 'win32')(
      'treats ".\\" as in-place (Windows shorthand)',
      () => {
        // `rayfin init .\` is the standard PowerShell spelling for
        // "scaffold here". Before the fix, this resolved to cwd but
        // `inPlace` was false → conflict prompt could fire → wipe cwd.
        expect(isInPlaceDirectory('.\\')).toBe(true);
      }
    );

    it.skipIf(process.platform !== 'win32')(
      'treats ".\\\\" as in-place (escaped Windows form)',
      () => {
        expect(isInPlaceDirectory('.\\\\')).toBe(true);
      }
    );

    // Windows path comparisons are case-insensitive because NTFS / ReFS
    // are case-insensitive by default. `process.cwd()` may return
    // `C:\Work` while a user-supplied absolute path is `c:\work`. Before
    // this fix, strict equality treated those as different paths and the
    // dispatcher routed into the non-in-place branch — where the
    // conflict-prompt + wipeTargetDirectory path could wipe the cwd on
    // user consent. This is a data-loss bug Copilot caught.
    //
    // These two tests override the default '/home/user/work' cwd mock
    // (from beforeEach) with an explicit Windows-shaped path. Without
    // the override the test would be tautological — POSIX-shaped
    // '/home/user/work' has no uppercase characters to alternate-case.
    it.skipIf(process.platform !== 'win32')(
      'treats absolute path with case-different drive letter as in-place',
      () => {
        vi.spyOn(process, 'cwd').mockReturnValue('C:\\Work\\Project');
        // cwd is `C:\Work\Project`; user passes `c:\Work\Project` —
        // same NTFS directory, different casing. Strict equality treats
        // these as different paths; case-insensitive comparison is what
        // we test here.
        expect(isInPlaceDirectory('c:\\Work\\Project')).toBe(true);
      }
    );

    it.skipIf(process.platform !== 'win32')(
      'treats absolute path with case-different segments as in-place',
      () => {
        vi.spyOn(process, 'cwd').mockReturnValue('C:\\Work\\Project');
        // Fully lowercased input. NTFS treats this as the same path,
        // and isInPlaceDirectory must agree — otherwise the wipe path
        // can fire on the cwd.
        expect(isInPlaceDirectory('c:\\work\\project')).toBe(true);
      }
    );
  });

  describe('paths that resolve to cwd (still in-place)', () => {
    it('treats absolute path equal to cwd as in-place', () => {
      expect(isInPlaceDirectory('/home/user/work')).toBe(true);
    });

    it('treats "./." as in-place', () => {
      expect(isInPlaceDirectory('./.')).toBe(true);
    });

    it('treats "foo/.." as in-place (resolves to cwd)', () => {
      // The slugifyDirectoryArg / printNextStepsBanner JSDocs both list
      // `foo/..` as a covered case. Pin it down so a future early-return
      // optimization that skips resolve() for non-dot paths can't regress
      // this silently.
      expect(isInPlaceDirectory('foo/..')).toBe(true);
    });
  });

  describe('non-in-place paths', () => {
    it('rejects a child directory', () => {
      expect(isInPlaceDirectory('my-app')).toBe(false);
    });

    it('rejects a relative subdirectory', () => {
      expect(isInPlaceDirectory('./my-app')).toBe(false);
    });

    it('rejects a different absolute path', () => {
      expect(isInPlaceDirectory('/home/user/other')).toBe(false);
    });

    it('rejects a parent-relative path', () => {
      expect(isInPlaceDirectory('../my-app')).toBe(false);
    });

    it('rejects a parent-relative path with a trailing slash', () => {
      expect(isInPlaceDirectory('../sibling-dir/')).toBe(false);
    });
  });
});

describe('resolveScaffoldTarget', () => {
  const cwd = '/home/user/work';

  beforeEach(() => {
    // Stub process.cwd() so targetPath resolution is deterministic
    // regardless of where the test runner is invoked from.
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('create-project semantics (directory OMITTED → child dir)', () => {
    // The bare `npm create @microsoft/rayfin` flow: no positional directory,
    // so the dispatcher leaves useProjectNameAsDirectory=true and the project
    // name becomes the child directory (vite/next-app convention).
    it('nests under <projectName>/ when in-place AND useProjectNameAsDirectory', () => {
      const result = resolveScaffoldTarget({
        directory: '.',
        projectName: 'rayfin-lyra',
        inputInPlace: true,
        useProjectNameAsDirectory: true,
      });

      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('rayfin-lyra');
      expect(result.targetPath).toBe(resolve(cwd, 'rayfin-lyra'));
    });

    it('slugifies a whitespace project name for the child directory', () => {
      const result = resolveScaffoldTarget({
        directory: '.',
        projectName: 'My App',
        inputInPlace: true,
        useProjectNameAsDirectory: true,
      });

      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('my-app');
      expect(result.targetPath).toBe(resolve(cwd, 'my-app'));
    });
  });

  describe('explicit in-place directory (`create-rayfin .` / portal use case)', () => {
    // Mirrors `create-rayfin . --project-name "rayfin-lyra" -t <url>`, the
    // exact command the Fabric portal emits. The dispatcher sets
    // useProjectNameAsDirectory=false because `.` was explicitly typed, so the
    // scaffold lands in cwd, NOT a `rayfin-lyra/` child directory.
    it('scaffolds in place when an explicit `.` disables useProjectNameAsDirectory', () => {
      const result = resolveScaffoldTarget({
        directory: '.',
        projectName: 'rayfin-lyra',
        inputInPlace: true,
        useProjectNameAsDirectory: false,
      });

      expect(result.inPlace).toBe(true);
      expect(result.directoryForFilesystem).toBe('.');
      expect(result.targetPath).toBe(resolve(cwd));
    });

    it('ignores the project name for the directory when scaffolding in place', () => {
      // Even with a project name set, an in-place scaffold must not derive the
      // on-disk directory from it — the project name only updates rayfin.yml.
      const result = resolveScaffoldTarget({
        directory: '.',
        projectName: 'Some Other Name',
        inputInPlace: true,
        useProjectNameAsDirectory: false,
      });

      expect(result.inPlace).toBe(true);
      expect(result.targetPath).toBe(resolve(cwd));
    });
  });

  describe('non-create semantics (`rayfin init .`)', () => {
    // Plain `rayfin init` never sets useProjectNameAsDirectory, so `.` is
    // always in-place.
    it('scaffolds in place for `.` when useProjectNameAsDirectory is unset', () => {
      const result = resolveScaffoldTarget({
        directory: '.',
        projectName: 'whatever',
        inputInPlace: true,
      });

      expect(result.inPlace).toBe(true);
      expect(result.directoryForFilesystem).toBe('.');
      expect(result.targetPath).toBe(resolve(cwd));
    });
  });

  describe('explicit child directory (never in-place)', () => {
    it('uses the explicit directory verbatim even when useProjectNameAsDirectory is set', () => {
      // useProjectNameAsDirectory only fires for in-place inputs; an explicit
      // child path always wins.
      const result = resolveScaffoldTarget({
        directory: 'my-app',
        projectName: 'Different Name',
        inputInPlace: false,
        useProjectNameAsDirectory: true,
      });

      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('my-app');
      expect(result.targetPath).toBe(resolve(cwd, 'my-app'));
    });

    it('slugifies a whitespace bare-name child directory', () => {
      const result = resolveScaffoldTarget({
        directory: 'My App',
        projectName: 'My App',
        inputInPlace: false,
        useProjectNameAsDirectory: false,
      });

      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('my-app');
      expect(result.targetPath).toBe(resolve(cwd, 'my-app'));
    });
  });
});

/**
 * End-to-end directory-resolution matrix.
 *
 * Exercises the full decision chain a user's `directory` argument flows
 * through, composed exactly as the dispatcher composes it:
 *   1. `inputInPlace = isInPlaceDirectory(directory)`
 *   2. `useProjectNameAsDirectory = createProjectSemantics && !directoryProvided`
 *      (the `init.ts` gate — create-project "nest under project name" semantics
 *      apply ONLY when the positional directory is omitted)
 *   3. `resolveScaffoldTarget(...)` returns the final `inPlace` and `directoryForFilesystem`
 *
 * Covers in-place variants, sub-directory scaffolding, and sibling/other
 * directories (`../sibling-dir/`) for both `create-rayfin` (create-project
 * semantics) and plain `rayfin init`.
 */
describe('directory resolution matrix (isInPlaceDirectory → resolveScaffoldTarget)', () => {
  const cwd = '/home/user/work';
  const projectName = 'rayfin-lyra';

  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Mirrors the `init.ts` gate verbatim. The dispatcher-level argv tests in
  // init-dispatcher-gating.test.ts independently prove the dispatcher derives
  // `directoryProvided` from whether the positional `[directory]` argument was
  // supplied (omitted → `undefined`); here we pin the final scaffold target
  // each (semantics, directory) pair lands on.
  function resolveFromArg(opts: {
    directory: string;
    createProjectSemantics: boolean;
    directoryProvided: boolean;
  }) {
    const useProjectNameAsDirectory =
      opts.createProjectSemantics && !opts.directoryProvided;
    return resolveScaffoldTarget({
      directory: opts.directory,
      projectName,
      inputInPlace: isInPlaceDirectory(opts.directory),
      useProjectNameAsDirectory,
    });
  }

  describe('create-rayfin (create-project semantics)', () => {
    // ── In-place variants ────────────────────────────────────────────────
    it('omitted directory nests under the project name', () => {
      // Bare `npm create @microsoft/rayfin`: no positional → the action
      // normalizes the omitted (undefined) directory to `.` with
      // directoryProvided=false → nest under <projectName>/.
      const result = resolveFromArg({
        directory: '.',
        createProjectSemantics: true,
        directoryProvided: false,
      });
      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('rayfin-lyra');
      expect(result.targetPath).toBe(resolve(cwd, 'rayfin-lyra'));
    });

    it('explicit "." scaffolds in place', () => {
      const result = resolveFromArg({
        directory: '.',
        createProjectSemantics: true,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(true);
      expect(result.directoryForFilesystem).toBe('.');
      expect(result.targetPath).toBe(resolve(cwd));
    });

    it('explicit "./" scaffolds in place', () => {
      const result = resolveFromArg({
        directory: './',
        createProjectSemantics: true,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(true);
      expect(result.directoryForFilesystem).toBe('./');
      expect(result.targetPath).toBe(resolve(cwd));
    });

    it('an absolute path equal to cwd scaffolds in place', () => {
      const result = resolveFromArg({
        directory: cwd,
        createProjectSemantics: true,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(true);
      expect(result.targetPath).toBe(resolve(cwd));
    });

    // POSIX-skipped: `\` is a literal filename char off win32, so `.\` only
    // resolves to cwd on Windows (path.resolve is platform-native). `.\` is
    // the standard PowerShell spelling for "scaffold here".
    it.skipIf(process.platform !== 'win32')(
      'explicit ".\\" (Windows) scaffolds in place',
      () => {
        const result = resolveFromArg({
          directory: '.\\',
          createProjectSemantics: true,
          directoryProvided: true,
        });
        expect(result.inPlace).toBe(true);
        expect(result.targetPath).toBe(resolve(cwd));
      }
    );

    // ── Sub-directory variants ───────────────────────────────────────────
    it('a bare sub-directory name scaffolds into that child directory', () => {
      const result = resolveFromArg({
        directory: 'my-app',
        createProjectSemantics: true,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('my-app');
      expect(result.targetPath).toBe(resolve(cwd, 'my-app'));
    });

    it('a whitespace sub-directory name is slugified for the folder', () => {
      const result = resolveFromArg({
        directory: 'My App',
        createProjectSemantics: true,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('my-app');
      expect(result.targetPath).toBe(resolve(cwd, 'my-app'));
    });

    it('a nested path-like sub-directory is honored verbatim', () => {
      const result = resolveFromArg({
        directory: './projects/my-app',
        createProjectSemantics: true,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('./projects/my-app');
      expect(result.targetPath).toBe(resolve(cwd, 'projects', 'my-app'));
    });

    // ── Sibling / other-directory variants ───────────────────────────────
    it('a sibling directory (`../sibling-dir/`) scaffolds outside cwd', () => {
      const result = resolveFromArg({
        directory: '../sibling-dir/',
        createProjectSemantics: true,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('../sibling-dir/');
      expect(result.targetPath).toBe(resolve(cwd, '..', 'sibling-dir'));
    });

    it('a sibling directory without a trailing slash resolves the same', () => {
      const result = resolveFromArg({
        directory: '../sibling-dir',
        createProjectSemantics: true,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('../sibling-dir');
      expect(result.targetPath).toBe(resolve(cwd, '..', 'sibling-dir'));
    });

    it('an absolute path elsewhere is honored verbatim', () => {
      const result = resolveFromArg({
        directory: '/home/user/elsewhere',
        createProjectSemantics: true,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('/home/user/elsewhere');
      expect(result.targetPath).toBe(resolve('/home/user/elsewhere'));
    });
  });

  describe('plain rayfin init (no create-project semantics)', () => {
    it('omitted directory scaffolds in place (never nests)', () => {
      const result = resolveFromArg({
        directory: '.',
        createProjectSemantics: false,
        directoryProvided: false,
      });
      expect(result.inPlace).toBe(true);
      expect(result.directoryForFilesystem).toBe('.');
      expect(result.targetPath).toBe(resolve(cwd));
    });

    it('explicit "." scaffolds in place', () => {
      const result = resolveFromArg({
        directory: '.',
        createProjectSemantics: false,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(true);
      expect(result.targetPath).toBe(resolve(cwd));
    });

    it('a bare sub-directory name scaffolds into that child directory', () => {
      const result = resolveFromArg({
        directory: 'my-app',
        createProjectSemantics: false,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(false);
      expect(result.directoryForFilesystem).toBe('my-app');
      expect(result.targetPath).toBe(resolve(cwd, 'my-app'));
    });

    it('a sibling directory (`../sibling-dir/`) scaffolds outside cwd', () => {
      const result = resolveFromArg({
        directory: '../sibling-dir/',
        createProjectSemantics: false,
        directoryProvided: true,
      });
      expect(result.inPlace).toBe(false);
      expect(result.targetPath).toBe(resolve(cwd, '..', 'sibling-dir'));
    });
  });
});

describe('runScaffoldPipeline', () => {
  const mode = 'plain' as const;
  const baseOptions = {
    targetPath: '/tmp/scaffold-test',
    projectName: 'My Test App',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
    hydrateDeploymentFromFabricMock.mockResolvedValue({
      workspaceDisplayName: 'Test Workspace',
      baasEndpoint: 'https://api.example.test',
      publishableKey: 'pk_test',
      envFilePath: '/tmp/scaffold-test/rayfin/.deployments.json',
    });
  });

  it('runs the scaffold callback before any post-scaffold steps', async () => {
    const order: string[] = [];
    const scaffold = vi.fn(async () => {
      order.push('scaffold');
    });
    customizeTemplateMock.mockImplementation(() => order.push('customize'));
    runRayfinInitFromTemplateMock.mockImplementation(async () => {
      order.push('runRayfinInitFromTemplate');
    });

    await runScaffoldPipeline(baseOptions, scaffold, mode);

    expect(scaffold).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('scaffold');
    expect(order).toContain('customize');
    expect(order).toContain('runRayfinInitFromTemplate');
  });

  it('allows requested storage when the template already enables data', async () => {
    const targetPath = join(
      tmpdir(),
      `rayfin-scaffold-services-${randomUUID()}`
    );
    const configPath = join(targetPath, 'rayfin', 'rayfin.yml');
    await mkdir(join(targetPath, 'rayfin'), { recursive: true });
    await writeFile(
      configPath,
      'services:\n  data:\n    enabled: true\n  storage:\n    enabled: false\n',
      'utf8'
    );
    existsSyncMock.mockImplementation((path: string) => path === configPath);

    try {
      await expect(
        runScaffoldPipeline(
          {
            targetPath,
            projectName: 'My Test App',
            services: 'storage',
            skipInstall: true,
          },
          async () => {},
          mode
        )
      ).resolves.toBeUndefined();
      expect(runRayfinInitFromTemplateMock).toHaveBeenCalledOnce();
    } finally {
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  describe('install guard', () => {
    it('skips installDependencies when no package.json exists in targetPath', async () => {
      existsSyncMock.mockReturnValue(false);

      await runScaffoldPipeline(
        { ...baseOptions, skipInstall: false },
        async () => {},
        mode
      );

      expect(installDependenciesMock).not.toHaveBeenCalled();
    });

    it('runs installDependencies when package.json exists and skipInstall is false', async () => {
      existsSyncMock.mockImplementation((p: string) =>
        p.endsWith('package.json')
      );

      await runScaffoldPipeline(
        { ...baseOptions, skipInstall: false },
        async () => {},
        mode
      );

      expect(installDependenciesMock).toHaveBeenCalledWith(
        baseOptions.targetPath
      );
    });

    it('skips installDependencies when skipInstall is true even with package.json', async () => {
      existsSyncMock.mockImplementation((p: string) =>
        p.endsWith('package.json')
      );

      await runScaffoldPipeline(
        { ...baseOptions, skipInstall: true },
        async () => {},
        mode
      );

      expect(installDependenciesMock).not.toHaveBeenCalled();
    });

    it('forwards preserveTemplatePackageVersions to the from-template sync', async () => {
      await runScaffoldPipeline(
        { ...baseOptions, preserveTemplatePackageVersions: true },
        async () => {},
        mode
      );

      expect(runRayfinInitFromTemplateMock).toHaveBeenCalledWith(
        baseOptions.targetPath,
        baseOptions.projectName,
        undefined,
        expect.any(Object),
        expect.objectContaining({ skipRayfinPackageInstall: true })
      );
    });

    it('forwards explicit services to the from-template sync', async () => {
      await runScaffoldPipeline(
        { ...baseOptions, services: 'auth,data,storage' },
        async () => {},
        mode
      );

      expect(runRayfinInitFromTemplateMock).toHaveBeenCalledWith(
        baseOptions.targetPath,
        baseOptions.projectName,
        undefined,
        expect.any(Object),
        expect.objectContaining({ services: 'auth,data,storage' })
      );
    });
  });

  describe('--item-id requires --workspace-id', () => {
    it('warns and drops --item-id when --workspace-id is omitted', async () => {
      const warnings: string[] = [];
      const captureMode = {
        log: vi.fn(),
        warn: (msg: string) => warnings.push(msg),
        error: vi.fn(),
      };
      // The pipeline uses modeWarn which routes to console.warn for 'plain' mode.
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation((msg: string) => warnings.push(msg));

      await runScaffoldPipeline(
        { ...baseOptions, itemId: 'item-orphan' },
        async () => {},
        mode
      );

      expect(
        warnings.some((w) => /--item-id requires --workspace-id/i.test(w))
      ).toBe(true);
      // runRayfinInitFromTemplate's `artifactContext` arg should have itemId dropped.
      expect(runRayfinInitFromTemplateMock).toHaveBeenCalled();
      const call = runRayfinInitFromTemplateMock.mock.calls[0];
      const artifactContext = call[3] as {
        workspaceId?: string;
        itemId?: string;
      };
      expect(artifactContext.itemId).toBeUndefined();

      consoleWarnSpy.mockRestore();
      void captureMode;
    });

    it('forwards --item-id when --workspace-id is provided', async () => {
      await runScaffoldPipeline(
        { ...baseOptions, workspaceId: 'ws-abc', itemId: 'item-def' },
        async () => {},
        mode
      );

      expect(runRayfinInitFromTemplateMock).toHaveBeenCalled();
      const call = runRayfinInitFromTemplateMock.mock.calls[0];
      const artifactContext = call[3] as {
        workspaceId?: string;
        itemId?: string;
      };
      expect(artifactContext.workspaceId).toBe('ws-abc');
      expect(artifactContext.itemId).toBe('item-def');
    });

    it('hydrates deployment silently by default', async () => {
      await runScaffoldPipeline(
        { ...baseOptions, workspaceId: 'ws-abc', itemId: 'item-def' },
        async () => {},
        mode
      );

      expect(hydrateDeploymentFromFabricMock).toHaveBeenCalledWith({
        projectRoot: baseOptions.targetPath,
        workspaceId: 'ws-abc',
        itemId: 'item-def',
        interactive: false,
      });
    });

    it('allows interactive deployment hydration only when caller opts in', async () => {
      await runScaffoldPipeline(
        {
          ...baseOptions,
          workspaceId: 'ws-abc',
          itemId: 'item-def',
          allowInteractiveFabricAuth: true,
        },
        async () => {},
        mode
      );

      expect(hydrateDeploymentFromFabricMock).toHaveBeenCalledWith({
        projectRoot: baseOptions.targetPath,
        workspaceId: 'ws-abc',
        itemId: 'item-def',
        interactive: true,
      });
    });

    it('continues scaffolding when parent deployment hydration fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      hydrateDeploymentFromFabricMock.mockRejectedValueOnce(
        new Error('auth unavailable')
      );

      await runScaffoldPipeline(
        { ...baseOptions, workspaceId: 'ws-abc', itemId: 'item-def' },
        async () => {},
        mode
      );

      expect(runRayfinInitFromTemplateMock).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "   The project will use the locally pre-seeded workspace + item ID; run 'rayfin dev' to resolve the backend endpoint and publishable key."
      );
      warn.mockRestore();
    });

    it('forwards --base-api-url to runRayfinInitFromTemplate', async () => {
      // Regression guard: bundled, external, and local handlers all route
      // through this pipeline. Dropping baseApiUrl from any of their dispatch
      // sites would silently skip the --base-api-url flag on the recursive
      // `rayfin init --from-template` invocation, breaking Fabric API
      // resolution in the inner init pass.
      await runScaffoldPipeline(
        {
          ...baseOptions,
          baseApiUrl: 'https://dxtapi.fabric.microsoft.com/v1',
        },
        async () => {},
        mode
      );

      expect(runRayfinInitFromTemplateMock).toHaveBeenCalled();
      const call = runRayfinInitFromTemplateMock.mock.calls[0];
      const artifactContext = call[3] as { baseApiUrl?: string };
      expect(artifactContext.baseApiUrl).toBe(
        'https://dxtapi.fabric.microsoft.com/v1'
      );
    });
  });
});

describe('wipeTargetDirectory', () => {
  const mode = 'plain' as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls rmSync with recursive + force on the target', () => {
    rmSyncMock.mockImplementation(() => undefined);

    wipeTargetDirectory('/tmp/some-target', mode);

    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/some-target', {
      recursive: true,
      force: true,
    });
  });

  it('emits modeError and exits 1 when rmSync throws (Windows EPERM/EBUSY etc.)', () => {
    rmSyncMock.mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const errors: string[] = [];
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((msg: string) => errors.push(msg));

    wipeTargetDirectory('/tmp/locked-target', mode);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(
      errors.some((e) => /Failed to clear target directory/i.test(e))
    ).toBe(true);
    expect(errors.some((e) => /EPERM/.test(e))).toBe(true);

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe('checkTargetConflict', () => {
  const mode = 'plain' as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats a non-existent directory (ENOENT) as empty / safe to proceed', async () => {
    // Regression: the previous catch-all `catch {}` defaulted isEmpty to
    // false, which would have prompted the user for an overwrite of a
    // directory that doesn't exist. ENOENT specifically must mean
    // "empty/safe to proceed".
    const nonExistent = `/definitely/does/not/exist/${Math.random()}`;
    const result = await checkTargetConflict(
      nonExistent,
      { nonInteractive: true, overwrite: false },
      mode
    );
    expect(result.shouldProceed).toBe(true);
    expect(result.consentedOverwrite).toBe(false);
    expect(result.targetWasEmpty).toBe(true);
  });

  it('does NOT wipe — caller is responsible for deferring the wipe', async () => {
    // Contract: checkTargetConflict only checks; wipeTargetDirectory is
    // a separate explicit call. This guards against re-introducing the
    // wipe-before-validate data-loss bug.
    const nonExistent = `/definitely/does/not/exist/${Math.random()}`;
    await checkTargetConflict(
      nonExistent,
      { nonInteractive: true, overwrite: true },
      mode
    );
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('treats an existing empty directory as safe to proceed without prompting', async () => {
    // Regression for the user-facing bug: `rayfin init my-app` where
    // `my-app/` is a pre-created empty directory should NOT prompt the
    // user (or cancel in non-interactive mode) to overwrite — there is
    // nothing to overwrite. The wrapper checks readdirSync emptiness
    // before delegating to the conflict prompt.
    const emptyDir = join(tmpdir(), `rayfin-empty-${randomUUID()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      // Non-interactive without --overwrite: previously the user-facing
      // flow cancelled here. Empty dirs must be treated as safe.
      const result = await checkTargetConflict(
        emptyDir,
        { nonInteractive: true, overwrite: false },
        mode
      );
      expect(result.shouldProceed).toBe(true);
      expect(result.consentedOverwrite).toBe(false);
      // targetWasEmpty must be true so callers attribute cleanup ownership
      // correctly: a partial scaffold into a previously-empty dir is ours
      // to clean up on failure (there was nothing of the user's to lose).
      expect(result.targetWasEmpty).toBe(true);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('reports targetWasEmpty=false when user consents to overwrite a non-empty dir', async () => {
    // Pairs with the empty-dir test above: when the dir was non-empty and
    // the user consented to overwrite via --overwrite, targetWasEmpty
    // must be false so callers can distinguish "we wiped user content" from
    // "the dir was empty when we started" — both lead to cleanup-on-failure
    // ownership, but for different reasons.
    const nonEmptyDir = join(tmpdir(), `rayfin-nonempty-${randomUUID()}`);
    mkdirSync(nonEmptyDir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(nonEmptyDir, 'sentinel.txt'), 'existing');
    try {
      const result = await checkTargetConflict(
        nonEmptyDir,
        { nonInteractive: true, overwrite: true },
        mode
      );
      expect(result.shouldProceed).toBe(true);
      expect(result.consentedOverwrite).toBe(true);
      expect(result.targetWasEmpty).toBe(false);
    } finally {
      await rm(nonEmptyDir, { recursive: true, force: true });
    }
  });
});

describe('assertTargetConflictOrThrow', () => {
  const mode = 'plain' as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns disposition without throwing on missing/empty targets', async () => {
    // Locks in the wrapper contract: empty/missing dirs flow through
    // without a thrown ScaffoldCancelledError, returning the metadata
    // callers need for cleanup-ownership decisions.
    const nonExistent = `/definitely/does/not/exist/${Math.random()}`;
    const result = await assertTargetConflictOrThrow(
      nonExistent,
      { nonInteractive: true, overwrite: false },
      mode
    );
    expect(result.consentedOverwrite).toBe(false);
    expect(result.targetWasEmpty).toBe(true);
  });

  it('throws ScaffoldCancelledError when user declines overwrite (non-interactive without --overwrite)', async () => {
    // Locks in the wrapper's reason for existing: callers no longer have
    // to remember to translate `!shouldProceed` into a typed throw.
    const nonEmptyDir = join(tmpdir(), `rayfin-decline-${randomUUID()}`);
    mkdirSync(nonEmptyDir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(nonEmptyDir, 'sentinel.txt'), 'existing');
    try {
      await expect(
        assertTargetConflictOrThrow(
          nonEmptyDir,
          { nonInteractive: true, overwrite: false },
          mode
        )
      ).rejects.toBeInstanceOf(ScaffoldCancelledError);
    } finally {
      await rm(nonEmptyDir, { recursive: true, force: true });
    }
  });

  it('returns consentedOverwrite=true when user passes --overwrite on a non-empty target', async () => {
    const nonEmptyDir = join(tmpdir(), `rayfin-consent-${randomUUID()}`);
    mkdirSync(nonEmptyDir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(nonEmptyDir, 'sentinel.txt'), 'existing');
    try {
      const result = await assertTargetConflictOrThrow(
        nonEmptyDir,
        { nonInteractive: true, overwrite: true },
        mode
      );
      expect(result.consentedOverwrite).toBe(true);
      expect(result.targetWasEmpty).toBe(false);
    } finally {
      await rm(nonEmptyDir, { recursive: true, force: true });
    }
  });
});
