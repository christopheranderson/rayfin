import { randomUUID } from 'crypto';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  checkDirectoryConflict,
  copyTemplateFiles,
  discoverBundledTemplates,
  filterDiscoverableTemplates,
  isTargetMissingOrEmpty,
  listBundledTemplates,
  runRayfinInitFromTemplate,
} from '../template-scaffold.js';

// runRayfinInitFromTemplate spawns a child `rayfin init` process; mock the
// child_process boundary so tests can inspect the argv it builds without
// launching a real process. `ora` is stubbed so no spinner writes to stdout.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('ora', () => ({
  default: () => ({
    start: () => ({ succeed: vi.fn(), warn: vi.fn(), fail: vi.fn() }),
  }),
}));

describe('checkDirectoryConflict', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `rayfin-conflict-test-${randomUUID()}`);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return true when directory does not exist', async () => {
    const result = await checkDirectoryConflict(testDir);
    expect(result).toBe(true);
  });

  it('should return false in non-interactive mode when directory exists and is non-empty', async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'sentinel.txt'), 'existing content');
    const result = await checkDirectoryConflict(testDir, {
      nonInteractive: true,
    });
    expect(result).toBe(false);
  });

  it('should return true in non-interactive mode when directory exists but is empty', async () => {
    mkdirSync(testDir, { recursive: true });
    const result = await checkDirectoryConflict(testDir, {
      nonInteractive: true,
    });
    expect(result).toBe(true);
  });

  it('should prompt user when directory exists and is non-empty in interactive mode', async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'sentinel.txt'), 'existing content');

    const inquirerModule = await import('inquirer');
    const promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockResolvedValue({ overwrite: true });

    const result = await checkDirectoryConflict(testDir);
    expect(result).toBe(true);
    expect(promptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'confirm',
        name: 'overwrite',
      })
    );

    promptSpy.mockRestore();
  });

  it('should not prompt and should return true when directory exists but is empty in interactive mode', async () => {
    mkdirSync(testDir, { recursive: true });

    const inquirerModule = await import('inquirer');
    const promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockResolvedValue({ overwrite: false });

    const result = await checkDirectoryConflict(testDir);
    expect(result).toBe(true);
    expect(promptSpy).not.toHaveBeenCalled();

    promptSpy.mockRestore();
  });

  it('should return false when user declines overwrite on a non-empty directory', async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'sentinel.txt'), 'existing content');

    const inquirerModule = await import('inquirer');
    const promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockResolvedValue({ overwrite: false });

    const result = await checkDirectoryConflict(testDir);
    expect(result).toBe(false);

    promptSpy.mockRestore();
  });

  it('should skip its own emptiness check when knownNonEmpty=true so an empty dir still hits the prompt path', async () => {
    // Locks in the TOCTOU fix: when the wrapper has already verified the
    // dir is non-empty, it passes knownNonEmpty=true. The inner helper
    // must NOT re-check emptiness (that's the redundant readdirSync that
    // also opens a TOCTOU race — if an external process empties the dir
    // between the wrapper's check and the inner's check, the inner would
    // falsely return true and the wrapper would interpret that as user
    // consent). We simulate the race by passing an EMPTY dir with the
    // knownNonEmpty flag — the inner should bypass the empty-check
    // short-circuit and route through the prompt logic instead.
    mkdirSync(testDir, { recursive: true });
    // dir is empty, but we lie to the helper to simulate a TOCTOU win
    const result = await checkDirectoryConflict(testDir, {
      nonInteractive: true,
      overwrite: false,
      knownNonEmpty: true,
    });
    // Because knownNonEmpty=true bypasses the empty-check short-circuit,
    // the helper falls into the non-interactive branch which requires
    // explicit --overwrite=true. Without it, returns false (would cancel).
    expect(result).toBe(false);
  });
});

describe('isTargetMissingOrEmpty', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `rayfin-istargetempty-${randomUUID()}`);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return true when the path does not exist (ENOENT)', () => {
    expect(isTargetMissingOrEmpty(testDir)).toBe(true);
  });

  it('should return true when the directory exists and is empty', () => {
    mkdirSync(testDir, { recursive: true });
    expect(isTargetMissingOrEmpty(testDir)).toBe(true);
  });

  it('should return false when the directory exists and contains files', () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'sentinel.txt'), 'x');
    expect(isTargetMissingOrEmpty(testDir)).toBe(false);
  });

  it('should return false when readdirSync throws a non-ENOENT error so callers fall through to the conflict prompt', () => {
    // Locks in the contract that distinguishes "missing" (treat as empty,
    // safe to scaffold) from other read errors (e.g., ENOTDIR / EACCES)
    // where state is unclear and we err on the side of prompting. Calling
    // readdirSync on a regular file throws ENOTDIR — exercising the catch's
    // ENOENT-only check without needing platform-specific permissions.
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, 'not-a-directory.txt');
    writeFileSync(filePath, 'x');
    expect(isTargetMissingOrEmpty(filePath)).toBe(false);
  });
});

describe('discoverBundledTemplates', () => {
  it('should return templates in sorted order', () => {
    const templates = filterDiscoverableTemplates([
      {
        name: 'zeta',
        displayName: 'Zeta',
        description: 'Zeta template',
        path: '/templates/zeta',
        packageJson: {},
        isLocal: false,
      },
      {
        name: 'dataapp',
        displayName: 'Data App',
        description: 'Registry-backed template',
        path: '/templates/dataapp',
        packageJson: {},
        isLocal: false,
      },
      {
        name: 'alpha',
        displayName: 'Alpha',
        description: 'Alpha template',
        path: '/templates/alpha',
        packageJson: {},
        isLocal: false,
      },
    ]);

    expect(templates.map((template) => template.name)).toEqual([
      'alpha',
      'dataapp',
      'zeta',
    ]);
  });

  it('should discover templates in sorted order', () => {
    const templates = discoverBundledTemplates();

    const names = templates.map((t) => t.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('should include at least one template', () => {
    const templates = discoverBundledTemplates();
    expect(templates.length).toBeGreaterThan(0);
  });
});

describe('listBundledTemplates', () => {
  it('should output valid JSON with name, displayName, and description', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const templates = discoverBundledTemplates();
    listBundledTemplates(templates);

    const output = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    for (const t of parsed) {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('displayName');
      expect(t).toHaveProperty('description');
    }

    logSpy.mockRestore();
  });
});

describe('package.json publishability', () => {
  it('should not include build-time scripts in files array', () => {
    const pkgPath = join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const files: string[] = pkg.files;

    // scripts/main is the runtime entrypoint — should be included
    expect(files).toContain('scripts/main');

    // The full "scripts" directory should NOT be in files
    // (would ship bundle-templates.ts, templateignore.ts, .templateignore)
    expect(files).not.toContain('scripts');
  });

  it('should have minimatch in devDependencies not dependencies', () => {
    const pkgPath = join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

    expect(pkg.dependencies?.minimatch).toBeUndefined();
    expect(pkg.devDependencies?.minimatch).toBeDefined();
  });
});

describe('pack-safe template ignore files', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = join(tmpdir(), `rayfin-ignore-source-${randomUUID()}`);
    targetDir = join(tmpdir(), `rayfin-ignore-target-${randomUUID()}`);
    mkdirSync(join(sourceDir, 'rayfin', 'functions'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.gitignore.template'),
      'root-ignore\n',
      'utf8'
    );
    writeFileSync(
      join(sourceDir, 'rayfin', '.gitignore.template'),
      'rayfin-ignore\n',
      'utf8'
    );
    writeFileSync(
      join(sourceDir, 'rayfin', 'functions', '.gitignore.template'),
      'functions-ignore\n',
      'utf8'
    );
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('restores root and nested ignore assets after template extraction', () => {
    copyTemplateFiles(sourceDir, targetDir);

    expect(readFileSync(join(targetDir, '.gitignore'), 'utf8')).toBe(
      'root-ignore\n'
    );
    expect(readFileSync(join(targetDir, 'rayfin', '.gitignore'), 'utf8')).toBe(
      'rayfin-ignore\n'
    );
    expect(
      readFileSync(join(targetDir, 'rayfin', 'functions', '.gitignore'), 'utf8')
    ).toBe('functions-ignore\n');
  });
});

describe('runRayfinInitFromTemplate child arguments', () => {
  const targetPath = join(tmpdir(), 'rayfin-template-scaffold-argv');

  // A fake child process: an EventEmitter with an `stderr` emitter. Emitting
  // `close` after the call resolves the promise runRayfinInitFromTemplate
  // returns (its executor registers the handler synchronously via spawn()).
  function stubChild(): EventEmitter & { stderr: EventEmitter } {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    return child;
  }

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('forwards --services=<list> to the from-template child process', async () => {
    const child = stubChild();
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>
    );

    const promise = runRayfinInitFromTemplate(
      targetPath,
      'My App',
      undefined,
      undefined,
      { services: 'auth,data,storage' }
    );
    child.emit('close', 0);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args).toContain('--services=auth,data,storage');
  });

  it('omits --services when no service selection is provided', async () => {
    const child = stubChild();
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>
    );

    const promise = runRayfinInitFromTemplate(targetPath, 'My App');
    child.emit('close', 0);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args.some((arg) => arg.startsWith('--services'))).toBe(false);
  });
});
