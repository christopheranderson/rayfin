import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { initFunctions } from '../helpers/init-functions.js';
import { createTempDir, readRayfinYml, runCli } from '../helpers/run-cli.js';
import { runRegistryDependent } from '../helpers/scaffold-template.js';

/**
 * Workspace-layout coverage for `rayfin functions init`.
 *
 * The `universal-app` template is an npm workspace: the root `package.json`
 * declares `workspaces: ["packages/*"]`, every service lives in its own
 * package, and there is no `rayfin/tsconfig.json` at all. Applying the
 * functions capability pack sets `services.functions.path: packages/functions`.
 *
 * `functions init` used to ignore that path and scaffold into `rayfin/functions`
 * anyway, emitting `references: [{ path: ".." }]` pointing at a `rayfin/`
 * directory with no tsconfig — so the very next `npm run build` died with
 * TS5083 and the command exited 1. These tests pin both halves of that fix.
 */

/** Build the post-pack `universal-app` project shape on disk. */
function createWorkspaceProject(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'universal-app-e2e',
        private: true,
        version: '1.0.0',
        workspaces: ['packages/*'],
      },
      null,
      2
    )
  );

  // Root tsconfig is a solution file referencing the workspace packages —
  // there is deliberately no `rayfin/tsconfig.json`.
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ files: [], references: [] }, null, 2)
  );

  mkdirSync(join(dir, 'rayfin'), { recursive: true });
  writeFileSync(
    join(dir, 'rayfin', 'rayfin.yml'),
    [
      'id: universal-app-e2e',
      'name: Universal App E2E',
      'version: 1.0.0',
      'services:',
      '  functions:',
      '    enabled: true',
      '    path: packages/functions',
      '    buildCommand: npm run build',
    ].join('\n') + '\n'
  );
}

/**
 * Build a *fresh* workspace project with no `services.functions` block at all.
 *
 * This is the shape a user gets from the `universal-app` template before the
 * functions capability pack is applied: npm workspaces are declared, but
 * nothing pins the functions location. Without workspace detection,
 * `functions init` falls back to `rayfin/functions` and drops a package
 * outside the workspace globs, where npm will not link it.
 */
function createFreshWorkspaceProject(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'universal-app-fresh-e2e',
        private: true,
        version: '1.0.0',
        workspaces: ['packages/*'],
      },
      null,
      2
    )
  );

  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ files: [], references: [] }, null, 2)
  );

  mkdirSync(join(dir, 'rayfin'), { recursive: true });
  writeFileSync(
    join(dir, 'rayfin', 'rayfin.yml'),
    [
      'id: universal-app-fresh-e2e',
      'name: Universal App Fresh E2E',
      'version: 1.0.0',
    ].join('\n') + '\n'
  );
}

describe.skipIf(!runRegistryDependent)(
  'rayfin functions init (workspace layout)',
  () => {
    it('scaffolds into services.functions.path and builds cleanly', async () => {
      const { dir, cleanup } = createTempDir('rayfin-fn-ws-');
      try {
        createWorkspaceProject(dir);

        const result = await initFunctions({ projectDir: dir });

        // The reported regression was a hard exit 1 on TS5083 during the
        // post-scaffold build.
        expect(
          result.exitCode,
          `functions init failed:\n${result.output}`
        ).toBe(0);
        expect(result.output).not.toContain('TS5083');

        const functionsDir = join(dir, 'packages', 'functions');
        expect(existsSync(join(functionsDir, 'package.json'))).toBe(true);
        expect(existsSync(join(functionsDir, 'host.json'))).toBe(true);
        expect(existsSync(join(functionsDir, 'src', 'function_app.ts'))).toBe(
          true
        );

        // The default location must never be created when a path is set.
        expect(existsSync(join(dir, 'rayfin', 'functions'))).toBe(false);

        // No dangling project reference to a non-existent rayfin/ project.
        const tsconfig = JSON.parse(
          readFileSync(join(functionsDir, 'tsconfig.json'), 'utf8')
        ) as { references?: unknown };
        expect(tsconfig.references).toBeUndefined();

        // The configured path survives the run untouched.
        const config = readRayfinYml(dir) as {
          services?: { functions?: { enabled?: boolean; path?: string } };
        };
        expect(config.services?.functions?.path).toBe('packages/functions');
        expect(config.services?.functions?.enabled).toBe(true);
      } finally {
        cleanup();
      }
    }, 360_000);

    it('preserves an existing workspace functions package on re-run', async () => {
      const { dir, cleanup } = createTempDir('rayfin-fn-ws-rerun-');
      try {
        createWorkspaceProject(dir);

        const first = await initFunctions({ projectDir: dir });
        expect(first.exitCode, first.output).toBe(0);

        const appPath = join(
          dir,
          'packages',
          'functions',
          'src',
          'function_app.ts'
        );
        const marker = '// rayfin-e2e-user-edit\n';
        writeFileSync(appPath, marker + readFileSync(appPath, 'utf8'));

        const second = await runCli(['functions', 'init'], {
          cwd: dir,
          timeoutMs: 300_000,
        });

        expect(second.exitCode, second.output).toBe(0);
        // Skip message must name the configured path, not rayfin/functions.
        expect(second.output).toContain('packages/functions/');
        expect(readFileSync(appPath, 'utf8')).toContain(marker);
      } finally {
        cleanup();
      }
    }, 600_000);

    it('auto-detects the workspace container when no path is configured', async () => {
      const { dir, cleanup } = createTempDir('rayfin-fn-ws-fresh-');
      try {
        createFreshWorkspaceProject(dir);

        const result = await initFunctions({ projectDir: dir });

        expect(result.exitCode, result.output).toBe(0);

        // The package must land inside the declared `packages/*` workspace
        // glob, not in rayfin/ where npm would never link it.
        expect(
          existsSync(join(dir, 'packages', 'functions', 'package.json'))
        ).toBe(true);
        expect(existsSync(join(dir, 'rayfin', 'functions'))).toBe(false);

        // The resolved location must be written back to rayfin.yml, or
        // `up functions deploy` and `dev functions apply` would keep
        // resolving rayfin/functions while the code lives elsewhere.
        expect(readFileSync(join(dir, 'rayfin', 'rayfin.yml'), 'utf8')).toMatch(
          /path:\s*packages\/functions/
        );
      } finally {
        cleanup();
      }
    }, 360_000);
  }
);
