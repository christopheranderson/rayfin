import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { functionsInit } from '../commands/functions/functions-init.js';
import { init } from '../commands/init.js';
import { CliHandledError } from '../errors.js';

describe.each(['init', 'functions init'] as const)(
  '%s Functions auth JSON errors',
  (command) => {
    let projectRoot: string;

    beforeEach(async () => {
      projectRoot = await mkdtemp(join(tmpdir(), 'rayfin-auth-json-'));
      await mkdir(join(projectRoot, 'rayfin'));
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`Unexpected process.exit(${code})`);
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await rm(projectRoot, { recursive: true, force: true });
    });

    it.each(
      [
        { enabled: false, auth: '{ type: delegated }' },
        { enabled: true, auth: '{ type: delegated }' },
        { enabled: false, auth: 'null' },
        { enabled: true, auth: '{}' },
      ].flatMap((settings) =>
        ['default', 'workspace', 'override'].flatMap((layout) =>
          ['root-json', 'trailing-json', 'output-json'].map((flags) => ({
            ...settings,
            layout,
            flags,
          }))
        )
      )
    )(
      'emits one error before writes for $layout/$flags, enabled=$enabled, auth=$auth',
      async ({ enabled, auth, layout, flags }) => {
        const config =
          'id: review-app\nname: Review App\nservices:\n  functions:\n' +
          `    enabled: ${enabled}\n    auth: ${auth}\n` +
          (layout === 'override' && command === 'init'
            ? '    path: custom/functions\n'
            : '');
        const configPath = join(projectRoot, 'rayfin', 'rayfin.yml');
        await writeFile(configPath, config);
        const manifest = JSON.stringify({
          name: 'review-app',
          private: true,
          ...(layout === 'workspace' ? { workspaces: ['packages/*'] } : {}),
        });
        const manifestPath = join(projectRoot, 'package.json');
        await writeFile(manifestPath, manifest);

        const root = new Command('rayfin')
          .option('--json', 'Emit JSON output', false)
          .option('--output <mode>', 'Select output mode')
          .option('--yes', 'Run non-interactively', false);
        if (command === 'init') {
          root.addCommand(init());
        } else {
          root.addCommand(new Command('functions').addCommand(functionsInit()));
        }
        const args =
          command === 'init'
            ? [
                'init',
                projectRoot,
                '--from-template',
                '--project-name',
                'Review App',
                '--services',
                'functions',
              ]
            : [
                'functions',
                'init',
                projectRoot,
                ...(layout === 'override'
                  ? ['--path', 'custom/functions', '--force']
                  : []),
              ];
        await expect(
          root.parseAsync(
            [
              ...(flags === 'root-json' ? ['--json'] : []),
              ...(flags === 'output-json' ? ['--output', 'json'] : []),
              '--yes',
              ...args,
              '--skip-install',
              ...(flags === 'trailing-json' ? ['--json'] : []),
            ],
            { from: 'user' }
          )
        ).rejects.toBeInstanceOf(CliHandledError);

        const writes = vi.mocked(process.stdout.write).mock.calls;
        expect(writes).toHaveLength(1);
        expect(JSON.parse(String(writes[0][0]))).toEqual({
          status: 'error',
          error: expect.stringContaining(
            'Set services.functions.auth.type to "application".'
          ),
        });
        expect(process.stderr.write).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
        expect(await readFile(configPath, 'utf8')).toBe(config);
        expect(await readFile(manifestPath, 'utf8')).toBe(manifest);
        for (const directory of ['rayfin', 'packages', 'custom']) {
          expect(existsSync(join(projectRoot, directory, 'functions'))).toBe(
            false
          );
        }
      }
    );
  }
);
